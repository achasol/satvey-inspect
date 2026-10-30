import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createTestFormat, createTestProperty, headers } from './helpers/formats';

const email = process.env.E2E_EMAIL || 'admin@satvey.local';
const password = process.env.E2E_PASSWORD || 'local-inspection-2026';
const photo = {
  name: 'badkamer.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAF0lEQVR4nGKKygv4z4APMKELAAIAAP//ZS4CHD5TmGgAAAAASUVORK5CYII=',
    'base64',
  ),
};
test.beforeEach(async ({ page }) => {
  // Exercise the real storage/API path without charging the configured vision provider.
  await page.route('**/api/v1/orgs/**/inspections/*/batches', async (route) => {
    if (route.request().method() === 'POST')
      await route.continue({
        postData: JSON.stringify({ ...route.request().postDataJSON(), analysisProvider: 'mock' }),
      });
    else await route.continue();
  });
});
async function login(page: Page) {
  await page.goto('/app');
  await page.getByLabel(/^E-mailadres/).fill(email);
  await page.getByRole('button', { name: 'Doorgaan', exact: true }).click();
  await page.getByLabel(/^Wachtwoord/).fill(password);
  await page.getByRole('button', { name: 'Inloggen', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inspecties', exact: true })).toBeVisible();
}
async function inspection(page: Page) {
  const account = await (await page.request.get('/api/v1/me')).json();
  const base = `/api/v1/orgs/${account.organisations[0].id}`;
  const format = await createTestFormat(page, base);
  const address = `Teststraat ${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  await createTestProperty(page, base, address);
  await page.getByRole('button', { name: 'Inspectie toevoegen', exact: true }).click();
  await page.getByLabel('Zoek woning', { exact: true }).fill(address);
  await page
    .getByRole('list', { name: 'Gevonden woningen' })
    .getByRole('button')
    .filter({ hasText: address })
    .click();
  await page.getByLabel('Inspectieformat', { exact: true }).selectOption(format.id);
  await page.getByRole('button', { name: 'Aanmaken en opnemen' }).click();
  await expect(page.getByRole('heading', { name: address, exact: true })).toBeVisible();
  return address;
}
async function capture(page: Page) {
  await page.getByLabel("Foto's toevoegen", { exact: true }).setInputFiles(photo);
  await page.getByRole('button', { name: 'Opname bewaren', exact: true }).click();
  await expect(page.getByText('Voorbeeldvoorstel', { exact: true })).toBeVisible({
    timeout: 15000,
  });
}

test('inspection columns stay aligned when statuses change across screen sizes', async ({
  page,
}, info) => {
  await login(page);
  const rows = [1, 2, 3].map((index) => ({
    id: `00000000-0000-4000-8000-00000000001${index}`,
    propertyId: `00000000-0000-4000-8000-00000000000${index}`,
    address: `Proefstraat ${index}`,
    postcode: '1234 AB',
    city: 'Utrecht',
    kind: index === 2 ? 'final' : 'pre',
    status: index === 2 ? 'final' : 'draft',
    scheduledAt: null,
    createdAt: '2026-10-30T10:00:00Z',
  }));
  await page.route('**/api/v1/orgs/*/inspections', async (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: rows }) : route.continue(),
  );
  await page.reload();
  const list = page.locator('[class*="inspectionList"]'),
    items = list.locator('a');
  await expect(items).toHaveCount(3);
  async function positions() {
    return items.evaluateAll((elements) =>
      elements.map((element) => {
        const type = element.querySelector('[class*="rowDate"]')!.getBoundingClientRect(),
          status = element.children[3].getBoundingClientRect(),
          icon = element.querySelector('[class*="propertyIcon"]')!;
        return { typeX: type.x, statusX: status.x, color: getComputedStyle(icon).backgroundColor };
      }),
    );
  }
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const before = await positions();
    expect(new Set(before.map((p) => Math.round(p.typeX))).size).toBe(1);
    expect(new Set(before.map((p) => Math.round(p.statusX))).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
  }
  await page.setViewportSize({
    width: info.project.name.includes('mobile') ? 390 : 1440,
    height: 900,
  });
  const before = await positions();
  rows[0].status = 'final';
  await page.evaluate(() => window.dispatchEvent(new Event('satvey-refresh')));
  await expect(items.first()).toContainText('Vastgelegd');
  const after = await positions();
  expect(after[0].typeX).toBeCloseTo(before[0].typeX, 0);
  expect(after[0].statusX).toBeCloseTo(before[0].statusX, 0);
  expect(after[0].color).toBe(before[0].color);
  expect(new Set(after.map((p) => p.color)).size).toBeGreaterThan(1);
  await page.screenshot({
    path: `tests/artifacts/inspection-list-${info.project.name}.png`,
    fullPage: true,
  });
});

test('formats supply inspection type, room names and written evidence without repeated fields', async ({
  page,
}) => {
  await login(page);
  const me = await (await page.request.get('/api/v1/me')).json(),
    base = `/api/v1/orgs/${me.organisations[0].id}`;
  const original = await createTestFormat(page, base),
    revision = await (
      await page.request.post(`${base}/formats/${original.id}/revisions`, { headers, data: {} })
    ).json();
  const format = await (await page.request.get(`${base}/formats/${revision.id}`)).json();
  format.kind = 'final';
  format.scopes[1].questions[0] = {
    ...format.scopes[1].questions[0],
    title: 'Beschrijf de badkamer',
    kind: 'text',
    evidence: 'statement',
    minPhotos: 0,
  };
  expect(
    (await page.request.put(`${base}/formats/${format.id}`, { headers, data: format })).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post(`${base}/formats/${format.id}/publish`, {
        headers,
        data: { revision: 2 },
      })
    ).ok(),
  ).toBe(true);
  const address = `Teststraat ${Date.now()}-900`;
  await createTestProperty(page, base, address);
  await page.getByRole('button', { name: 'Inspectie toevoegen', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Type inspectie', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Plaats', { exact: true })).toBeHidden();
  await dialog.getByLabel('Zoek woning', { exact: true }).fill(address);
  await dialog
    .getByRole('list', { name: 'Gevonden woningen' })
    .getByRole('button')
    .filter({ hasText: address })
    .click();
  await dialog.getByLabel('Inspectieformat', { exact: true }).selectOption(format.id);
  await dialog.getByRole('button', { name: 'Aanmaken en opnemen', exact: true }).click();
  await expect(page.getByRole('heading', { name: address, exact: true })).toBeVisible();
  const iid = page.url().match(/inspections\/([^/]+)/)![1],
    path = `${base}/inspections/${iid}`;
  expect((await (await page.request.get(path)).json()).inspection.kind).toBe('final');
  await page.getByRole('button', { name: 'Ruimte toevoegen', exact: true }).click();
  await expect(page.getByLabel('Ruimtenaam', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Badkamer 2 toevoegen', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Ruimtes', exact: true })
    .getByRole('button', { name: 'Badkamer 2 Open', exact: true })
    .click();
  await page.getByRole('link', { name: 'Beoordelen', exact: true }).click();
  const room = page.getByRole('region', { name: 'Badkamer 2', exact: true });
  await room.getByText('Beschrijf de badkamer', { exact: true }).click();
  await expect(room.getByLabel('Beantwoording', { exact: true })).toHaveCount(0);
  await expect(
    room.getByLabel('Onderbouwing of geschreven waarneming', { exact: true }),
  ).toBeHidden();
  await room
    .getByLabel('Antwoord', { exact: true })
    .fill('De wand naast de deur is droog en onbeschadigd.');
  await room.getByRole('button', { name: 'Antwoord bewaren', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Badkamer 2', exact: true })
      .getByRole('button', { name: 'Ruimte goedkeuren', exact: true }),
  ).toBeEnabled({
    timeout: 15000,
  });
  await page
    .getByRole('region', { name: 'Badkamer 2', exact: true })
    .getByRole('button', { name: 'Ruimte goedkeuren', exact: true })
    .click();
  await expect(
    page
      .getByRole('region', { name: 'Badkamer 2', exact: true })
      .getByRole('region', { name: 'Ruimtesamenvatting', exact: true })
      .getByText('Goedgekeurd', { exact: true }),
  ).toBeVisible();
  expect((await page.request.post(`${path}/report`, { headers, data: {} })).status()).toBe(422); // Original mandatory room remains unresolved.
});

test('login asks for email first and resets the password step when email changes', async ({
  page,
}) => {
  await page.goto('/app');
  await expect(page.getByLabel(/^Wachtwoord/)).toHaveCount(0);
  await expect(page.getByLabel(/Organisatiecode/)).toHaveCount(0);
  await page.getByLabel(/^E-mailadres/).fill(email);
  await page.getByRole('button', { name: 'Doorgaan', exact: true }).click();
  await expect(page.getByLabel(/^Wachtwoord/)).toBeVisible();
  await page.getByLabel(/^E-mailadres/).fill('another@unknown.example');
  await expect(page.getByLabel(/^Wachtwoord/)).toHaveCount(0);
});

test('canonical email domain goes directly to SSO without showing a password', async ({ page }) => {
  await page.route('**/api/v1/auth/discover', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ method: 'sso', url: '/api/v1/auth/oidc/start?org=canonical' }),
    }),
  );
  await page.route('**/api/v1/auth/oidc/start?org=canonical', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<main><h1>Organisatie-SSO</h1></main>',
    }),
  );
  await page.goto('/app');
  await page.getByLabel(/^E-mailadres/).fill('inspector@canonical.example');
  await page.getByRole('button', { name: 'Doorgaan', exact: true }).click();
  await expect(page).toHaveURL(/auth\/oidc\/start\?org=canonical/);
  await expect(page.getByRole('heading', { name: 'Organisatie-SSO' })).toBeVisible();
  await expect(page.getByLabel(/^Wachtwoord/)).toHaveCount(0);
});

test('photos become reviewed observations and a signed immutable report', async ({ page }) => {
  await login(page);
  await inspection(page);
  await capture(page);
  await page.getByRole('link', { name: 'Beoordelen', exact: true }).click();
  await page.getByLabel('Titel bevinding', { exact: true }).fill('Beschadiging naast douche');
  await page
    .getByLabel('Beschrijving', { exact: true })
    .fill('De wandafwerking naast de douche is beschadigd.');
  await page.getByRole('button', { name: 'Goedkeuren', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Bevinding beoordelen', exact: true })
      .getByText('Goedgekeurd', { exact: true }),
  ).toBeVisible();
  await page.getByText('Overzicht vastgelegd?', { exact: true }).click();
  await page
    .getByRole('group', { name: 'Antwoord', exact: true })
    .getByRole('button', { name: 'Ja', exact: true })
    .click();
  await page.getByRole('button', { name: /^Bronfoto 1:/ }).click();
  await page.getByRole('button', { name: 'Antwoord bewaren', exact: true }).click();
  const reviewed = page
    .getByRole('region', { name: 'Badkamer', exact: true })
    .getByRole('button', { name: 'Ruimte goedkeuren', exact: true });
  await expect(reviewed).toBeEnabled({ timeout: 15000 });
  await reviewed.click();
  await expect(page.getByText('Beoordeeld', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByRole('link', { name: 'Rapport', exact: true }).click();
  await expect(page.getByRole('article')).toContainText('Beschadiging naast douche');
  await page.getByRole('link', { name: 'Opnemen', exact: true }).click();
  await page.getByLabel("Foto's toevoegen", { exact: true }).setInputFiles(photo);
  await page.getByRole('link', { name: 'Rapport', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Rapport vastleggen', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/concepten op dit apparaat/)).toBeVisible();
  await page.getByRole('link', { name: 'Opnemen', exact: true }).click();
  await page.getByRole('button', { name: 'badkamer.png verwijderen', exact: true }).click();
  await page.getByRole('link', { name: 'Rapport', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rapport vastleggen', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Rapport vastleggen', exact: true }).click();
  const finalise = page.getByRole('dialog', { name: 'Inspectie afronden', exact: true });
  await expect(finalise.getByText('Handtekeningen (optioneel)', { exact: true })).toBeVisible();
  await expect(
    finalise.getByRole('button', { name: 'Rapport definitief vastleggen', exact: true }),
  ).toBeEnabled();
  for (const [index, name] of ['Sanne Inspecteur', 'Robin Bewoner'].entries()) {
    await finalise.getByRole('button', { name: 'Ondertekenaar toevoegen', exact: true }).click();
    await finalise.getByLabel('Naam ondertekenaar', { exact: true }).nth(index).fill(name);
    const pad = finalise.getByRole('img', {
      name: `Handtekening ondertekenaar ${index + 1}`,
      exact: true,
    });
    await pad.scrollIntoViewIfNeeded();
    const box = (await pad.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.2, { steps: 8 });
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.7, { steps: 8 });
    await page.mouse.up();
  }
  const signatureAxe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(signatureAxe.violations).toEqual([]);
  await finalise
    .getByRole('button', { name: 'Rapport definitief vastleggen', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Vastgelegd rapport', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Vastgelegde handtekeningen', exact: true }),
  ).toContainText('Robin Bewoner');
  await page.reload();
  await expect(
    page.getByRole('img', { name: 'Handtekening van Sanne Inspecteur', exact: true }),
  ).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  const pdfResponse = page.waitForResponse((response) => response.url().endsWith('/report/pdf'));
  await page.getByRole('button', { name: 'PDF downloaden', exact: true }).click();
  expect((await pdfResponse).status()).toBe(200);
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^satvey-voorinspectie-.*-vastgelegd\.pdf$/);
  expect(await download.failure()).toBeNull();
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  const pdf = Buffer.concat(chunks);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.toString().trimEnd().endsWith('%%EOF')).toBe(true);
  await page.reload();
  await expect(page.getByRole('article')).toContainText(
    'De wandafwerking naast de douche is beschadigd.',
  );
  await expect(page.getByRole('button', { name: 'Rapport vastleggen', exact: true })).toHaveCount(
    0,
  );
  const iid = page.url().match(/inspections\/([^/]+)/)![1];
  const account = await (await page.request.get('/api/v1/me')).json();
  const base = `/api/v1/orgs/${account.organisations[0].id}`;
  const signed = await (await page.request.get(`${base}/inspections/${iid}/report`)).json();
  expect(signed.signatures.map((signature: { role: string }) => signature.role)).toEqual([
    'inspector',
    'resident',
  ]);
  await page.getByRole('button', { name: 'Inspectie verwijderen', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Inspectie verwijderen', exact: true })
    .getByRole('button', { name: 'Definitief verwijderen', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Inspecties', exact: true })).toBeVisible();
  expect((await page.request.get(`${base}/inspections/${iid}/report`)).status()).toBe(404);
});

test('inspection deletion confirms the address, handles failure and removes local drafts', async ({
  page,
}) => {
  await login(page);
  const address = await inspection(page);
  const iid = page.url().match(/inspections\/([^/]+)/)![1];
  const account = await (await page.request.get('/api/v1/me')).json();
  const base = `/api/v1/orgs/${account.organisations[0].id}`;
  const scope = `${account.user.id}:${account.organisations[0].id}`;
  const path = `${base}/inspections/${iid}`;
  const dossier = await (await page.request.get(path)).json();
  await page.getByRole('link', { name: 'Alle inspecties', exact: true }).click();
  await page.getByLabel('Inspecties zoeken', { exact: true }).fill(address);
  const remove = page.getByRole('button', {
    name: `Inspectie verwijderen: ${address}`,
    exact: true,
  });
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'Inspectie verwijderen', exact: true });
  await expect(dialog).toContainText(address);
  await dialog.getByRole('button', { name: 'Annuleren', exact: true }).click();
  expect((await page.request.get(path)).status()).toBe(200);
  await page.evaluate(
    async ({ scope, iid }) => {
      const modulePath = '/src/workspace/outbox.ts';
      const outbox = await import(modulePath);
      await outbox.draftPut(`${scope}:inspectionDraft:${iid}:camera`, { id: 'local-draft' });
      await outbox.saveAction({
        id: `delete-test-${iid}`,
        scope,
        inspectionId: iid,
        kind: 'edit',
        path: '/unused',
        payload: {},
        state: 'conflict',
        createdAt: Date.now(),
      });
    },
    { scope, iid },
  );
  let fail = true;
  await page.route(`**/api/v1${path.replace('/api/v1', '')}`, (route) => {
    if (route.request().method() === 'DELETE' && fail)
      return route.fulfill({ status: 503, json: { error: 'Tijdelijk niet beschikbaar' } });
    return route.continue();
  });
  await remove.click();
  await dialog.getByRole('button', { name: 'Definitief verwijderen', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Tijdelijk niet beschikbaar');
  expect((await page.request.get(path)).status()).toBe(200);
  fail = false;
  await dialog.getByRole('button', { name: 'Definitief verwijderen', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(remove).toHaveCount(0);
  expect((await page.request.get(`${base}/properties/${dossier.inspection.propertyId}`)).ok()).toBe(
    true,
  );
  const remaining = await page.evaluate(
    async ({ scope, iid }) => {
      const modulePath = '/src/workspace/outbox.ts';
      const outbox = await import(modulePath);
      return {
        draft: await outbox.draftGet(`${scope}:inspectionDraft:${iid}:camera`),
        pending: (await outbox.actions(scope)).filter(
          (action: { inspectionId: string }) => action.inspectionId === iid,
        ),
      };
    },
    { scope, iid },
  );
  expect(remaining.draft).toBeUndefined();
  expect(remaining.pending).toEqual([]);
});

test('inline findings can be approved, rejected and corrected without an edit step', async ({
  page,
}) => {
  await login(page);
  await inspection(page);
  await capture(page);
  await page.getByRole('link', { name: 'Beoordelen', exact: true }).click();
  const generated = page.getByRole('region', { name: 'Bevinding beoordelen', exact: true }).first();
  await expect(generated.getByLabel('Beschrijving', { exact: true })).toBeVisible();
  await expect(generated.getByLabel('Titel bevinding', { exact: true })).toBeVisible();
  await expect(generated.getByRole('button', { name: 'Aanpassen', exact: true })).toHaveCount(0);
  await generated.getByRole('button', { name: 'Afwijzen', exact: true }).click();
  await expect(generated.getByText('Afgewezen', { exact: true })).toBeVisible();
  await generated
    .getByLabel('Beschrijving', { exact: true })
    .fill('Schade aan de wand naast het raam.');
  await generated.getByRole('button', { name: 'Goedkeuren', exact: true }).click();
  await expect(generated.getByText('Goedgekeurd', { exact: true })).toBeVisible();
  const batch = page.locator('article').filter({ has: generated });
  await expect(batch.getByText('Beoordeeld', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Opname beoordeeld', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Bevinding toevoegen', exact: true }).click();
  const manual = page
    .getByRole('region', { name: 'Bevinding beoordelen', exact: true })
    .filter({ hasNot: page.getByText('Voorbeeldvoorstel', { exact: true }) });
  const description = 'De geïsoleerde wand heeft beschadigingen aan de afwerking. '
    .repeat(6)
    .trim();
  await manual.getByLabel('Beschrijving', { exact: true }).fill(description);
  await manual.getByRole('button', { name: 'Goedkeuren', exact: true }).click();
  await expect(manual.getByText('Goedgekeurd', { exact: true })).toBeVisible();
  const iid = page.url().match(/inspections\/([^/]+)/)![1],
    me = await (await page.request.get('/api/v1/me')).json();
  const data = await (
    await page.request.get(`/api/v1/orgs/${me.organisations[0].id}/inspections/${iid}`)
  ).json();
  const saved = data.observations.find((o: { source: string }) => o.source === 'manual');
  expect(saved.description).toBe(description);
  expect(Buffer.byteLength(saved.title, 'utf8')).toBeLessThanOrEqual(160);
});

test('offline capture survives reload and uploads once after reconnecting', async ({
  page,
  context,
}) => {
  await login(page);
  await inspection(page);
  let rejectUploads = true;
  await page.route('**/api/v1/orgs/**/inspections/*/batches', (route) =>
    rejectUploads ? route.abort('internetdisconnected') : route.fallback(),
  );
  await page.getByLabel("Foto's toevoegen", { exact: true }).setInputFiles(photo);
  await page.getByRole('button', { name: 'Opname bewaren', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'op apparaat' }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'op apparaat' }).first()).toBeVisible();
  rejectUploads = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText('Voorbeeldvoorstel', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole('article')).toHaveCount(1);
  const state = await context.storageState(),
    browser = context.browser();
  if (browser) {
    const other = await browser.newContext({ storageState: state });
    const second = await other.newPage();
    await second.goto(page.url());
    await expect(second.getByText('Voorbeeldvoorstel', { exact: true })).toBeVisible();
    await other.close();
  }
});

test('editing conflicts retain local text for comparison', async ({ page }) => {
  await login(page);
  await inspection(page);
  await capture(page);
  await page.getByRole('link', { name: 'Beoordelen', exact: true }).click();
  await page.getByLabel('Beschrijving', { exact: true }).fill('Mijn lokale waarneming');
  await page.route('**/observations/*', async (route) => {
    if (route.request().method() === 'PUT')
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'De bevinding is gewijzigd. Herlaad de nieuwste versie.' }),
      });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Goedkeuren', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Synchronisatieproblemen' })).toContainText(
    'Mijn lokale waarneming',
  );
  await page.reload();
  await expect(page.getByRole('region', { name: 'Synchronisatieproblemen' })).toContainText(
    'Mijn lokale waarneming',
  );
});

test('capture and review reflow and meet automated accessibility checks', async ({
  page,
}, testInfo) => {
  await login(page);
  await inspection(page);
  await capture(page);
  for (const stage of ['capture', 'review', 'report']) {
    await page
      .getByRole('link', {
        name: (
          { capture: 'Opnemen', review: 'Beoordelen', report: 'Rapport' } as Record<string, string>
        )[stage],
        exact: true,
      })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `${stage} at ${width}px`,
      ).toBeTruthy();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    if (testInfo.project.name === 'chromium')
      await page.screenshot({
        path: `tests/artifacts/workspace-${stage}-phone.png`,
        fullPage: true,
      });
  }
});

test('real MediaRecorder audio is persisted and played back', async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium',
    'Chromium virtual microphone verifies real recording; devices need manual checks.',
  );
  await context.grantPermissions(['microphone']);
  await login(page);
  await inspection(page);
  await page.getByRole('button', { name: 'Audio opnemen', exact: true }).click();
  await expect(page.getByText(/Microfoon actief/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Stop 0:0[2-9]/ })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: /^Stop/ }).click();
  await expect(page.locator('audio')).toBeVisible();
  await page.getByRole('button', { name: 'Opname bewaren', exact: true }).click();
  await expect(page.getByText('Spraaknotitie · intern')).toBeVisible({ timeout: 15000 });
  await page.reload();
  await expect(page.getByText('Spraaknotitie · intern')).toBeVisible();
  const url = await page.locator('audio').getAttribute('src');
  const response = await page.request.get(url!);
  expect(response.ok()).toBeTruthy();
  expect((await response.body()).length).toBeGreaterThan(100);
});
