import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { HandoverWorkspace } from './Handover';

const local = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  api: vi.fn(),
}));
vi.mock('./outbox', () => ({
  cacheGet: vi.fn(async () => undefined),
  cachePut: vi.fn(async () => {}),
  draftGet: vi.fn(async (key: string) => local.get(key)),
  draftPut: vi.fn(async (key: string, value: unknown) => {
    local.set(key, structuredClone(value));
  }),
  draftRemove: vi.fn(async (key: string) => {
    local.delete(key);
  }),
}));
beforeEach(() => {
  vi.mocked(api).mockReset();
  local.clear();
});
const initial = () => ({
  report: {
    id: 'report',
    property: {},
    sources: [
      {
        key: 'answer:confirmed',
        kind: 'answer',
        title: 'Ventilatie',
        description: 'Ventilatie werkt niet',
        location: 'Badkamer',
        photoIds: [],
        value: false,
        outcome: 'unacceptable',
      },
      {
        key: 'observation:tap',
        kind: 'observation',
        title: 'Kraan',
        description: 'Lekkage bij aansluiting',
        location: 'Badkamer',
        photoIds: [],
      },
    ],
  },
  draft: {
    version: 0,
    destination: '',
    destinationId: '',
    externalReference: '',
    proposals: [] as {
      id: string;
      sourceKeys: string[];
      description: string;
      location: string;
      urgency: string;
      unit: string;
      elementCode: string;
    }[],
  },
  exports: [],
  deliveries: [] as unknown[],
  destinations: [
    { id: 'receiver', name: 'Intern onderhoud', ready: true, enabled: true, reason: '' },
  ],
});
function setup() {
  const state = initial();
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path.endsWith('/manual-handovers')) return [];
    if (options?.method === 'PUT') {
      state.draft = { ...JSON.parse(options.body as string), version: state.draft.version + 1 };
      return structuredClone(state.draft);
    }
    if (path.endsWith('/approve')) {
      state.deliveries = [
        {
          id: 'delivery',
          destinationId: 'receiver',
          destination: 'Intern onderhoud',
          draftVersion: state.draft.version,
          status: 'queued',
          attempts: 0,
          error: '',
          createdAt: '2026-10-31T10:00:00Z',
          acceptedAt: null,
          nextAttemptAt: '2026-10-31T10:00:00Z',
          acceptedCount: 0,
          receipts: [],
          proposals: structuredClone(state.draft.proposals),
        },
      ];
      return { id: 'delivery' };
    }
    return structuredClone(state);
  });
  return state;
}
function view(canWrite = true) {
  return render(
    <MemoryRouter>
      <HandoverWorkspace
        path="/orgs/org/inspections/inspection"
        scope="user:org"
        org="org"
        canWrite={canWrite}
      />
    </MemoryRouter>,
  );
}

it('selects findings by room and creates separate proposals without copying or technical mapping fields', async () => {
  setup();
  view();
  fireEvent.click(
    await screen.findByRole('checkbox', {
      name: 'Selecteer alle getoonde bevindingen in Badkamer',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Onderhoudsvoorstellen maken' }));
  expect(screen.getByLabelText('Werkomschrijving voorstel 1')).toHaveValue(
    'Ventilatie: Ventilatie werkt niet',
  );
  expect(screen.getByLabelText('Werkomschrijving voorstel 2')).toHaveValue(
    'Kraan: Lekkage bij aansluiting',
  );
  fireEvent.change(screen.getByLabelText('Werkomschrijving voorstel 1'), {
    target: { value: 'Herstel ventilatie' },
  });
  fireEvent.change(screen.getByLabelText('Urgentie voorstel 1'), { target: { value: 'soon' } });
  fireEvent.click(screen.getByRole('button', { name: 'Wijzigingen opslaan' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('opgeslagen'));
  const saved = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'PUT');
  expect(JSON.parse(saved![1]!.body as string).proposals[0]).toMatchObject({
    sourceKeys: ['answer:confirmed'],
    description: 'Herstel ventilatie',
    urgency: 'soon',
  });
  expect(screen.queryByLabelText(/Eenheid-URI/)).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /download|pakket/i })).not.toBeInTheDocument();
});

it('automatically saves selection changes and queues approval without a download', async () => {
  setup();
  view();
  fireEvent.change(await screen.findByLabelText('Ontvangend systeem'), {
    target: { value: 'receiver' },
  });
  await waitFor(
    () => expect(screen.getByRole('button', { name: 'Overdracht goedkeuren' })).toBeEnabled(),
    { timeout: 3000 },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Overdracht goedkeuren' }));
  await screen.findByText('In wachtrij');
  expect(
    vi
      .mocked(api)
      .mock.calls.some(
        ([path, options]) => path.endsWith('/handover/approve') && options?.method === 'POST',
      ),
  ).toBe(true);
  expect(
    vi
      .mocked(api)
      .mock.calls.some(([path]) => path.includes('/export') || path.endsWith('/handovers')),
  ).toBe(false);
  expect(screen.getByRole('button', { name: 'Overdracht goedkeuren' })).toBeDisabled();
});

it('combines selected sources into one editable proposal', async () => {
  setup();
  view();
  fireEvent.click(
    await screen.findByRole('checkbox', {
      name: 'Selecteer alle getoonde bevindingen in Badkamer',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Combineren tot één voorstel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Wijzigingen opslaan' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('opgeslagen'));
  const saved = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'PUT');
  expect(JSON.parse(saved![1]!.body as string).proposals).toHaveLength(1);
  expect(JSON.parse(saved![1]!.body as string).proposals[0].sourceKeys).toEqual([
    'answer:confirmed',
    'observation:tap',
  ]);
});

it('preserves local edits during a version conflict and offers explicit comparison', async () => {
  const state = setup();
  const normal = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path.endsWith('/manual-handovers')) return [];
    if (options?.method === 'PUT') throw new ApiError(409, 'De overdracht is gewijzigd.');
    return normal(path, options);
  });
  view();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Ventilatie' }));
  fireEvent.click(screen.getByRole('button', { name: 'Onderhoudsvoorstellen maken' }));
  fireEvent.change(screen.getByLabelText('Werkomschrijving voorstel 1'), {
    target: { value: 'Mijn herstelvoorstel' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Wijzigingen opslaan' }));
  await screen.findByRole('region', { name: 'Versieconflict' });
  expect(screen.getByLabelText('Werkomschrijving voorstel 1')).toHaveValue('Mijn herstelvoorstel');
  expect(local.size).toBe(1);
  state.draft.version = 2;
  state.draft.destination = 'Collega';
  fireEvent.click(screen.getByRole('button', { name: 'Nieuwste versie vergelijken' }));
  await screen.findByText('Serverversie 2 · Collega');
  expect(screen.getByLabelText('Werkomschrijving voorstel 1')).toHaveValue('Mijn herstelvoorstel');
});

it('restores scoped local changes and keeps viewers read-only', async () => {
  const state = setup();
  local.set('user:org:handover:inspection', {
    ...state.draft,
    externalReference: 'Hersteld concept',
  });
  const rendered = view();
  expect(await screen.findByLabelText('Externe zaak- of orderreferentie (optioneel)')).toHaveValue(
    'Hersteld concept',
  );
  rendered.unmount();
  local.clear();
  view(false);
  expect(await screen.findByLabelText('Ontvangend systeem')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Overdracht goedkeuren' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Bevindingen selecteren' })).not.toBeInTheDocument();
});
