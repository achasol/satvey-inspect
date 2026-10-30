import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { createTestFormat, createTestProperty, headers } from './helpers/formats';

async function login(page: Page) {
  await page.goto('/app');
  await page.getByLabel(/^E-mailadres/).fill(process.env.E2E_EMAIL || 'admin@satvey.local');
  await page.getByRole('button', { name: 'Doorgaan', exact: true }).click();
  await page.getByLabel(/^Wachtwoord/).fill(process.env.E2E_PASSWORD || 'local-inspection-2026');
  await page.getByRole('button', { name: 'Inloggen', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inspecties', exact: true })).toBeVisible();
  const me = await (await page.request.get('/api/v1/me')).json();
  return `/api/v1/orgs/${me.organisations[0].id}`;
}
test('format builder publishes questions, norm links, examples and talking prompts', async ({
  page,
}, info) => {
  const base = await login(page),
    fixture = await createTestFormat(page, base);
  await page.goto('/app/formats');
  await page.getByRole('button', { name: 'Format toevoegen', exact: true }).click();
  const dialog = page.getByRole('dialog'),
    name = `E2E Format builder ${randomUUID()}`;
  await dialog.getByLabel(/^Naam/).fill(name);
  await dialog.getByLabel('Normenkader', { exact: true }).selectOption(fixture.normVersionId);
  await dialog.getByRole('button', { name: 'Concept aanmaken', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Badkamer 1', exact: true }).click();
  const question = page.getByRole('article').first();
  await question.getByLabel('Vraag', { exact: true }).fill('Controleer de wandafwerking');
  await question
    .getByLabel('Spreekhulp voor inspecteur', { exact: true })
    .fill('Beschrijf losse afwerking, scheuren en waar ze zitten.');
  await question.getByLabel('Antwoordtype', { exact: true }).selectOption('quality');
  const norm = await (await page.request.get(`${base}/norms/${fixture.normVersionId}`)).json();
  await question
    .getByLabel('Gekoppelde norm', { exact: true })
    .selectOption(norm.rules.find((r: { code: string }) => r.code === 'AFWERK').id);
  await question.getByText('Criteria en voorbeelden bekijken', { exact: true }).click();
  await expect(question.getByText('Acceptabel:', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Concept bewaren', exact: true }).click();
  await expect(page.getByText('Concept bewaard', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Voorbeeld', exact: true }).click();
  await expect(
    page.getByText('Beschrijf losse afwerking, scheuren en waar ze zitten.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Publiceren', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Nieuwe versie', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  const axe = await new AxeBuilder({ page })
    .include('#workspace')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({
    path: `tests/artifacts/formats-builder-${info.project.name}.png`,
    fullPage: true,
  });
});

test('talking prompts guide capture and conditional requirements close through explicit review', async ({
  page,
}, info) => {
  const base = await login(page),
    fixture = await createTestFormat(page, base);
  const revision = await (
    await page.request.post(`${base}/formats/${fixture.id}/revisions`, { headers, data: {} })
  ).json();
  const doc = await (await page.request.get(`${base}/formats/${revision.id}`)).json();
  const parent = doc.scopes[1].questions[0];
  parent.title = 'Is schade zichtbaar?';
  parent.talkingPrompt = 'Beschrijf de wanden en benoem eventuele schade.';
  doc.scopes[1].questions.push({
    ...parent,
    id: randomUUID(),
    title: 'Detailfoto van de schade',
    kind: 'evidence',
    talkingPrompt: 'Benoem de plek van de schade en maak een detailfoto.',
    condition: { questionId: parent.id, equals: 'true' },
  });
  expect((await page.request.put(`${base}/formats/${doc.id}`, { headers, data: doc })).ok()).toBe(
    true,
  );
  expect(
    (
      await page.request.post(`${base}/formats/${doc.id}/publish`, {
        headers,
        data: { revision: 2 },
      })
    ).ok(),
  ).toBe(true);
  const pid = (await createTestProperty(page, base, `Teststraat ${randomUUID()}`)).id,
    iid = randomUUID();
  expect(
    (
      await page.request.post(`${base}/inspections`, {
        headers,
        data: { id: iid, propertyId: pid, kind: 'pre', formatVersionId: doc.id },
      })
    ).ok(),
  ).toBe(true);
  await page.route('**/api/v1/orgs/**/inspections/*/batches', async (route) =>
    route.request().method() === 'POST'
      ? route.continue({
          postData: JSON.stringify({ ...route.request().postDataJSON(), analysisProvider: 'mock' }),
        })
      : route.continue(),
  );
  await page.goto(`/app/inspections/${iid}/capture`);
  const guide = page.getByRole('complementary', { name: 'Spreekhulp' });
  await expect(guide).toContainText('Beschrijf de wanden en benoem eventuele schade.');
  await guide
    .getByRole('button', { name: 'Spreekhulp overslaan: Is schade zichtbaar?', exact: true })
    .click();
  await expect(guide).toContainText('Benoem de plek van de schade');
  const initial = await (await page.request.get(`${base}/inspections/${iid}`)).json();
  expect(initial.answers.every((a: { status: string }) => a.status === 'missing')).toBe(true);
  await guide.getByRole('button', { name: 'Verborgen gesprekspunten tonen', exact: true }).click();
  await page.getByLabel("Foto's toevoegen", { exact: true }).setInputFiles({
    name: 'overzicht.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAF0lEQVR4nGKKygv4z4APMKELAAIAAP//ZS4CHD5TmGgAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await page.getByRole('button', { name: 'Opname bewaren', exact: true }).click();
  await expect(page.getByText('Voorbeeldvoorstel', { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole('link', { name: 'Beoordelen', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Badkamer', exact: true })
      .getByRole('button', { name: 'Ruimte goedkeuren', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Afwijzen', exact: true }).click();
  await page.getByText('Is schade zichtbaar?', { exact: true }).click();
  await page
    .getByRole('group', { name: 'Antwoord', exact: true })
    .getByRole('button', { name: 'Nee', exact: true })
    .click();
  await page.getByRole('button', { name: /^Bronfoto 1:/ }).click();
  let conflictOnce = true;
  await page.route('**/answers/*', async (route) => {
    if (route.request().method() === 'PUT' && conflictOnce) {
      conflictOnce = false;
      const payload = route.request().postDataJSON();
      const concurrent = await page.request.put(route.request().url(), {
        headers,
        data: { ...payload, value: true },
      });
      expect(concurrent.ok()).toBe(true);
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Dit antwoord is gewijzigd. Vergelijk de nieuwste versie.' }),
      });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Antwoord bewaren', exact: true }).click();
  await page.getByRole('button', { name: 'Vergelijk met server', exact: true }).click();
  const comparison = page.getByRole('dialog', { name: 'Antwoord vergelijken', exact: true });
  await expect(comparison).toContainText('Op de server');
  await expect(comparison).toContainText('Jouw lokale antwoord');
  await comparison
    .getByRole('button', { name: 'Mijn antwoord verder bewerken', exact: true })
    .click();
  await expect(
    page
      .getByRole('group', { name: 'Antwoord', exact: true })
      .getByRole('button', { name: 'Nee', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Antwoord bewaren', exact: true }).click();

  await expect(page.getByText('Detailfoto van de schade', { exact: true })).toHaveCount(0, {
    timeout: 15000,
  });
  await expect(
    page
      .getByRole('region', { name: 'Badkamer', exact: true })
      .getByRole('button', { name: 'Ruimte goedkeuren', exact: true }),
  ).toBeEnabled({
    timeout: 20000,
  });
  await page
    .getByRole('region', { name: 'Badkamer', exact: true })
    .getByRole('button', { name: 'Ruimte goedkeuren', exact: true })
    .click();
  await expect(
    page
      .getByRole('region', { name: 'Badkamer', exact: true })
      .getByRole('button', { name: 'Ruimte goedkeuren', exact: true }),
  ).toBeDisabled();
  await expect(
    page
      .getByRole('region', { name: 'Badkamer', exact: true })
      .getByRole('region', { name: 'Ruimtesamenvatting', exact: true })
      .getByText('Goedgekeurd', { exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Rapport', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Inspectierapport' })).toContainText(
    'Is schade zichtbaar?: Nee',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({
    path: `tests/artifacts/formats-review-${info.project.name}.png`,
    fullPage: true,
  });
});
