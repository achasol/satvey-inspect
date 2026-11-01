import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Checkbox, Field } from '../components/ui';
import { api, json, type HandoverDestination } from './api';
import { useResource } from './useResource';
import { Select, ErrorNotice, errorText, announceRefresh } from './shared';
import s from './workspace.module.css';

export const syncCategoryLabels: Record<string, string> = {
  property: 'Woningcontext',
  status: 'Planning en status',
  rooms: 'Ruimtes',
  findings: 'Bevestigde bevindingen',
  assessments: 'Bevestigde beoordelingen',
  agreements: 'Afspraken en verantwoordelijkheid',
  photos: 'Bronfoto’s en markeringen',
  reports: 'Vastgestelde rapporten en handtekeningen',
  audio: 'Originele audio',
  transcripts: 'Transcripties',
};
type Mapping = {
  enabled: boolean;
  resource: string;
  fields: Record<string, string>;
  testPayload: Record<string, unknown>;
};
type Capability = {
  category: string;
  state: string;
  declared: boolean;
  readTested: boolean;
  writeTested: boolean;
  message: string;
  receiverId?: string;
  cleanup?: string;
};
type Profile = {
  destinationId: string;
  enabled: boolean;
  environment: string;
  revision: number;
  openApiUrl: string;
  categories: Record<string, Mapping>;
  tests: Capability[];
  testedAt?: string;
};
const stateLabels: Record<string, string> = {
  unknown: 'Niet bewezen',
  read_tested: 'Leestoegang getest',
  write_tested: 'Schrijven getest',
  permission_denied: 'Geen toegang',
  unsupported: 'Niet ondersteund',
  pending: 'In wachtrij',
  processing: 'Synchroniseren',
  retrying: 'Opnieuw proberen',
  blocked: 'Aandacht nodig',
  done: 'Gesynchroniseerd',
  cancelled: 'Geannuleerd',
};
export function SyncProfileEditor({
  base,
  scope,
  destination,
}: {
  base: string;
  scope: string;
  destination: HandoverDestination;
}) {
  const { data, error } = useResource<Profile>(scope, `${base}/sync-profiles/${destination.id}`);
  return (
    <>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {data && (
        <ProfileForm
          key={`${destination.id}:${data.revision}`}
          base={base}
          destination={destination}
          initial={data}
        />
      )}
    </>
  );
}
function ProfileForm({
  base,
  destination,
  initial,
}: {
  base: string;
  destination: HandoverDestination;
  initial: Profile;
}) {
  const [draft, setDraft] = useState(initial),
    [fields, setFields] = useState<Record<string, string>>(() =>
      Object.fromEntries(
        Object.entries(initial.categories).map(([key, m]) => [
          key,
          JSON.stringify(m.fields, null, 2),
        ]),
      ),
    ),
    [fixtures, setFixtures] = useState<Record<string, string>>(() =>
      Object.fromEntries(
        Object.entries(initial.categories).map(([key, m]) => [
          key,
          JSON.stringify(m.testPayload || {}, null, 2),
        ]),
      ),
    ),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [tests, setTests] = useState(initial.tests || []);
  const update = (category: string, update: Partial<Mapping>) => {
    setDirty(true);
    setDraft({
      ...draft,
      categories: {
        ...draft.categories,
        [category]: {
          ...(draft.categories[category] || {
            enabled: false,
            resource: '',
            fields: {},
            testPayload: {},
          }),
          ...update,
        },
      },
    });
  };
  async function test(mode: string) {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ results: Capability[] }>(
        `${base}/sync-profiles/${destination.id}/test`,
        json('POST', { mode }),
      );
      setTests(result.results);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className={s.syncProfile}>
      <summary>Automatische synchronisatie en leveranciersmogelijkheden</summary>
      <form
        className={s.stack}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            const categories = Object.fromEntries(
              Object.entries(draft.categories).map(([key, mapping]) => [
                key,
                {
                  ...mapping,
                  fields: JSON.parse(fields[key] || '{}'),
                  testPayload: JSON.parse(fixtures[key] || '{}'),
                },
              ]),
            );
            await api(
              `${base}/sync-profiles/${destination.id}`,
              json('PUT', { ...draft, categories }),
            );
            setDirty(false);
            announceRefresh();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          Satvey synchroniseert interne inspectiegegevens automatisch. Conceptbevindingen blijven
          intern. Audio en transcripties gaan alleen mee als je ze afzonderlijk inschakelt.
        </p>
        <Select
          label="Omgeving"
          value={draft.environment}
          onChange={(environment) => {
            setDraft({ ...draft, environment });
            setDirty(true);
          }}
        >
          <option value="production">Productie</option>
          <option value="sandbox">Sandbox</option>
        </Select>
        <Field
          label="OpenAPI-specificatie (JSON, optioneel)"
          value={draft.openApiUrl || ''}
          type="url"
          onChange={(e) => {
            setDraft({ ...draft, openApiUrl: e.target.value });
            setDirty(true);
          }}
        />
        {Object.entries(syncCategoryLabels).map(([category, label]) => {
          const mapping = draft.categories[category];
          return (
            <section key={category} className={`${s.scoreLevel} ${s.stack}`}>
              <Checkbox
                label={label}
                checked={mapping?.enabled || false}
                onCheckedChange={(enabled) => update(category, { enabled })}
              />
              <Field
                label={`Resource voor ${label.toLowerCase()}`}
                placeholder={`${destination.dossierUrl}/informatieobjecten`}
                value={mapping?.resource || ''}
                type="url"
                onChange={(e) => update(category, { resource: e.target.value })}
              />
              <details>
                <summary>Veldtoewijzing en sandbox-testrecord</summary>
                <p className={s.muted}>
                  Bronpaden: title, description, data.veldnaam, unitUri, file.base64, file.size,
                  file.mime, file.name. Bronidentiteit wordt automatisch toegevoegd. Stem velden af
                  op het leverancierscontract.
                </p>
                <label className={s.field}>
                  <span>Veldtoewijzing (JSON)</span>
                  <textarea
                    aria-label={`Veldtoewijzing ${label}`}
                    rows={4}
                    value={fields[category] || '{}'}
                    onChange={(e) => {
                      setFields({ ...fields, [category]: e.target.value });
                      update(category, {});
                    }}
                  />
                </label>
                <label className={s.field}>
                  <span>Geldig sandbox-testrecord (JSON)</span>
                  <textarea
                    aria-label={`Testrecord ${label}`}
                    rows={3}
                    value={fixtures[category] || '{}'}
                    onChange={(e) => {
                      setFixtures({ ...fixtures, [category]: e.target.value });
                      update(category, {});
                    }}
                  />
                </label>
              </details>
            </section>
          );
        })}
        <Checkbox
          label="Automatisch synchroniseren inschakelen"
          checked={draft.enabled}
          onCheckedChange={(enabled) => {
            setDraft({ ...draft, enabled });
            setDirty(true);
          }}
        />
        <p className={s.muted}>
          Ook de bestemming moet ingeschakeld zijn. Een leestest bewijst geen schrijftoegang. De
          schrijfproef is alleen beschikbaar op een expliciet ingestelde sandboxbestemming.
        </p>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <div className={s.actions}>
          <Button type="submit" loading={busy}>
            Synchronisatie opslaan
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={dirty || busy || initial.revision === 0}
            onClick={() => void test('read')}
          >
            Mogelijkheden testen
          </Button>
          {draft.environment === 'sandbox' && (
            <Button
              type="button"
              variant="secondary"
              disabled={dirty || busy || initial.revision === 0}
              onClick={() => void test('sandbox')}
            >
              Schrijfproef in sandbox
            </Button>
          )}
        </div>
        {!!tests.length && (
          <div className={s.tableScroll}>
            <table className={s.historyTable}>
              <thead>
                <tr>
                  <th>Gegevens</th>
                  <th>Aangeboden</th>
                  <th>Bewezen mogelijkheden</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {tests.map((result) => (
                  <tr key={result.category}>
                    <td>{syncCategoryLabels[result.category]}</td>
                    <td>{result.declared ? 'In specificatie' : 'Niet vastgesteld'}</td>
                    <td>{stateLabels[result.state] || result.state}</td>
                    <td>
                      {result.message}
                      {result.cleanup && <p>{result.cleanup}</p>}
                      {result.receiverId && <small>Testrecord: {result.receiverId}</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </form>
    </details>
  );
}
type SyncJob = {
  id: string;
  category: string;
  sourceRevision: number;
  status: string;
  error: string;
  destination: string;
  createdAt: string;
  completedAt?: string;
};
export function SyncStatus({
  base,
  path,
  scope,
  admin = false,
}: {
  base: string;
  path?: string;
  scope: string;
  admin?: boolean;
}) {
  const { data, error, reload } = useResource<SyncJob[]>(scope, `${path || base}/sync`),
    [failure, setFailure] = useState('');
  const attention = data?.some((job) => ['blocked', 'retrying'].includes(job.status));
  return (
    <section className={`${s.panel} ${s.stack}`} aria-label="Interne synchronisatie">
      <h3>Interne synchronisatie</h3>
      <p>
        {attention
          ? 'Synchronisatie vraagt aandacht'
          : data?.some((job) => ['pending', 'processing'].includes(job.status))
            ? 'Gegevens worden gesynchroniseerd'
            : data?.length
              ? 'Gegevens gesynchroniseerd'
              : 'Nog geen automatische synchronisatie ingesteld of uitgevoerd.'}
      </p>
      {(error || failure) && <ErrorNotice>{error || failure}</ErrorNotice>}
      {admin && <Link to="/app/settings?tab=handover">VERA-koppeling beheren</Link>}
      {!!data?.length && (
        <details>
          <summary>Synchronisatiestatus per gegevenscategorie</summary>
          <ul className={s.syncJobList}>
            {data.map((job) => (
              <li key={job.id}>
                <strong>
                  {syncCategoryLabels[job.category]} · {job.destination}
                </strong>
                <p>
                  {stateLabels[job.status]} · dossierversie {job.sourceRevision}
                </p>
                {admin && job.error && <p>{job.error}</p>}
                {admin && ['blocked', 'retrying'].includes(job.status) && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      try {
                        await api(`${base}/sync/${job.id}/retry`, json('POST', {}));
                        reload();
                      } catch (e) {
                        setFailure(errorText(e));
                      }
                    }}
                  >
                    Opnieuw proberen
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
