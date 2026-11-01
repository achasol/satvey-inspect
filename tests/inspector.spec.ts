import { captureFiles } from './helpers/capture';
import { test, expect, request } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
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
  await page.getByLabel('Inspectiesjabloon', { exact: true }).selectOption(format.id);
  await page.getByRole('button', { name: 'Aanmaken' }).click();
  await expect(page.getByRole('heading', { name: address, exact: true })).toBeVisible();
  return address;
}
async function capture(page: Page) {
  await captureFiles(page, photo);
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
  await page.route(/\/api\/v1\/orgs\/[^/]+\/inspection-page(?:\?.*)?$/, async (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            items: rows,
            total: rows.length,
            open: rows.filter((r) => r.status === 'draft').length,
          },
        })
      : route.continue(),
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

test('inspection pagination resets for postcode searches and shows server results', async ({
  page,
}) => {
  await login(page);
  const rows = Array.from({ length: 51 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    propertyId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    address: `Paginastraat ${index + 1}`,
    postcode: index === 50 ? '9876 ZX' : '1234 AB',
    city: 'Utrecht',
    kind: 'pre',
    status: 'draft',
    scheduledAt: null,
    createdAt: '2026-10-30T10:00:00Z',
  }));
  await page.route(/\/api\/v1\/orgs\/[^/]+\/inspection-page(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const params = new URL(route.request().url()).searchParams;
    const offset = Number(params.get('offset') || 0);
    const query = params.get('q') || '';
    await route.fulfill({
      json: {
        items: query
          ? rows.filter((row) => row.postcode === query)
          : rows.slice(offset, offset + 50),
        total: query ? rows.filter((row) => row.postcode === query).length : rows.length,
        open: rows.length,
      },
    });
  });
  await page.reload();
  const items = page.locator('[class*="inspectionList"] a');
  await expect(items).toHaveCount(50);
  await page.getByRole('button', { name: 'Volgende pagina', exact: true }).click();
  await expect(items).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: "Inspectiepagina's" })).toContainText(
    'Pagina 2',
  );
  await page.getByRole('textbox', { name: 'Inspecties zoeken' }).fill('9876 ZX');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('9876 ZX');
  await expect(page.getByRole('navigation', { name: "Inspectiepagina's" })).toContainText(
    'Pagina 1',
  );
  await expect(page.getByRole('button', { name: 'Volgende pagina', exact: true })).toBeDisabled();
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
  format.signingPolicy = 'legacy';
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
  await dialog.getByLabel('Inspectiesjabloon', { exact: true }).selectOption(format.id);
  await dialog.getByRole('button', { name: 'Aanmaken', exact: true }).click();
  await expect(page.getByRole('heading', { name: address, exact: true })).toBeVisible();
  const iid = page.url().match(/inspections\/([^/]+)/)![1],
    path = `${base}/inspections/${iid}`;
  expect((await (await page.request.get(path)).json()).inspection.kind).toBe('final');
  await page.getByRole('button', { name: 'Ruimte toevoegen', exact: true }).click();
  const addRoom = page.getByRole('dialog', { name: 'Ruimte toevoegen', exact: true });
  await expect(addRoom.getByLabel('Ruimtetype', { exact: true })).toHaveValue(format.scopes[1].id);
  await expect(addRoom.getByRole('textbox', { name: 'Ruimtenaam', exact: true })).toHaveValue(
    'Badkamer 2',
  );
  await addRoom.getByRole('button', { name: 'Toevoegen', exact: true }).click();
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
      .getByRole('button', { name: 'Beoordeling bevestigen', exact: true }),
  ).toBeEnabled({
    timeout: 15000,
  });
  await page
    .getByRole('region', { name: 'Badkamer 2', exact: true })
    .getByRole('button', { name: 'Beoordeling bevestigen', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: 'Ruimtes', exact: true })
    .getByRole('button', { name: /^Badkamer 2/ })
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
  // Capture, review, two signatures, accessibility, PDF export and deletion
  // constitute a full visit; budget for slower WebKit runs on capped CPUs.
  test.setTimeout(240_000);
  await login(page);
  const address = await inspection(page);
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
    .getByRole('button', { name: 'Beoordeling bevestigen', exact: true });
  await expect(reviewed).toBeEnabled({ timeout: 15000 });
  await reviewed.click();
  await page
    .getByRole('navigation', { name: 'Ruimtes', exact: true })
    .getByRole('button', { name: /^Badkamer/ })
    .click();
  await expect(page.getByText('Beoordeeld', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByRole('link', { name: 'Rapport', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Inspectierapport', exact: true })).toContainText(
    'Beschadiging naast douche',
  );
  await expect(page.getByRole('button', { name: 'Foto’s toevoegen', exact: true })).toHaveCount(0);
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
    page.getByRole('heading', { name: 'Definitief inspectierapport', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Vastgelegde handtekeningen', exact: true }),
  ).toContainText('Robin Bewoner');
  await page.reload();
  await expect(
    page.getByRole('img', { name: 'Handtekening van Sanne Inspecteur', exact: true }),
  ).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  const pdfResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/report/pdf'),
  );
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
  await expect(page.getByRole('article', { name: 'Inspectierapport', exact: true })).toContainText(
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
  page.setDefaultTimeout(30_000);
  const receivingBase = process.env.VERA_RECEIVER_URL;
  expect(receivingBase).toBeTruthy();
  const receiver = await request.newContext({
    baseURL: receivingBase,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'X-Test-Control-Key': 'dummy-control-secret-only-for-tests' },
  });
  const unit = `e2e-${iid}`;
  expect(
    (
      await receiver.post('/_test/seed', {
        data: { resource: '/vastgoed/v4/eenheden', record: { id: unit, code: unit } },
      })
    ).status(),
  ).toBe(201);
  await receiver.dispose();
  const destinationName = `Onderhoud ${iid.slice(0, 8)}`;
  await page.goto('/app/settings?tab=handover');
  await page.getByRole('button', { name: 'Bestemming toevoegen', exact: true }).click();
  const destinationForm = page.getByRole('form', { name: 'VERA-bestemming bewerken' });
  for (const [label, value] of [
    ['Naam ontvangend systeem', destinationName],
    ['Aanvullende API-basis-URL (optioneel)', `${receivingBase}/onderhoud/v4`],
    ['Dossier API-basis-URL', `${receivingBase}/dossier/v4`],
    ['Vastgoed API-basis-URL (optioneel)', `${receivingBase}/vastgoed/v4`],
    ['OAuth2-token-URL', `${receivingBase}/oauth/token`],
    ['OAuth2-client-ID', 'satvey-test'],
    ['OAuth2-clientgeheim', 'dummy-client-secret-only-for-tests'],
    ['Bronorganisatie', `E2E-${iid}`],
    ['Bronadministratie', 'SATVEY'],
  ])
    await destinationForm.getByLabel(label, { exact: true }).fill(value);
  await destinationForm.getByLabel('Bestemming inschakelen', { exact: true }).check();
  await destinationForm.getByRole('button', { name: 'Bestemming opslaan', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'VERA-synchronisatie', exact: true })
      .getByRole('status')
      .filter({ hasText: 'VERA-bestemming opgeslagen' }),
  ).toContainText('VERA-bestemming opgeslagen');
  await destinationForm.getByRole('button', { name: 'Bewerken sluiten', exact: true }).click();
  const mapping = page.getByRole('region', {
    name: 'Woning koppelen voor synchronisatie',
    exact: true,
  });
  await mapping
    .getByLabel('Bestemming voor woningkoppeling', { exact: true })
    .selectOption({ label: destinationName });
  await mapping.getByLabel('Zoek woning voor synchronisatie', { exact: true }).fill(address);
  await mapping.getByRole('button').filter({ hasText: address }).first().click();
  await mapping
    .getByLabel('Eenheid-URI in het ontvangende systeem', { exact: true })
    .fill(`${receivingBase}/vastgoed/v4/eenheden/${unit}`);
  await mapping
    .getByRole('button', { name: 'Woningkoppeling controleren en opslaan', exact: true })
    .click();
  await expect(
    page
      .getByRole('region', { name: 'VERA-synchronisatie', exact: true })
      .getByRole('status')
      .filter({ hasText: 'gecontroleerd en gekoppeld' }),
  ).toContainText('gecontroleerd en gekoppeld');
  await page.goto(`/app/inspections/${iid}/dossier`);
  await expect(
    page.getByRole('region', { name: 'Interne synchronisatie', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Overdracht goedkeuren', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Onderhoudsvoorstellen maken', exact: true }),
  ).toHaveCount(0);
});

test('archiving refuses local work, preserves the dossier and allows restoration', async ({
  page,
}) => {
  await login(page);
  const address = await inspection(page);
  const iid = page.url().match(/inspections\/([^/]+)/)![1];
  const account = await (await page.request.get('/api/v1/me')).json();
  const base = `/api/v1/orgs/${account.organisations[0].id}`;
  const scope = `${account.user.id}:${account.organisations[0].id}`;
  const path = `${base}/inspections/${iid}`;
  await page.evaluate(
    async ({ scope, iid }) => {
      const modulePath = '/src/workspace/outbox.ts';
      const outbox = await import(modulePath);
      await outbox.draftPut(`${scope}:inspectionDraft:${iid}:camera`, { id: 'local-draft' });
    },
    { scope, iid },
  );
  await page.getByText('Meer acties', { exact: true }).click();
  await page.getByRole('button', { name: 'Inspectie archiveren', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Inspectie archiveren', exact: true });
  await expect(dialog).toContainText(address);
  await dialog.getByRole('textbox', { name: 'Reden', exact: true }).fill('Dubbele opdracht');
  await dialog.getByRole('button', { name: 'Inspectie archiveren', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('lokale wijzigingen');
  await page.evaluate(
    async ({ scope, iid }) => {
      const modulePath = '/src/workspace/outbox.ts';
      const outbox = await import(modulePath);
      await outbox.draftRemove(`${scope}:inspectionDraft:${iid}:camera`);
    },
    { scope, iid },
  );
  await dialog.getByRole('button', { name: 'Inspectie archiveren', exact: true }).click();
  await expect(dialog).toBeHidden();
  const archived = await (await page.request.get(path)).json();
  expect(archived.inspection.archivedAt).toBeTruthy();
  await page.goto(`/app/inspections/${iid}/report`);
  await page.getByText('Meer acties', { exact: true }).click();
  await page.getByRole('button', { name: 'Inspectie herstellen', exact: true }).click();
  const restore = page.getByRole('dialog', { name: 'Inspectie herstellen', exact: true });
  await restore.getByRole('textbox', { name: 'Reden', exact: true }).fill('Opdracht hervatten');
  await restore.getByRole('button', { name: 'Inspectie herstellen', exact: true }).click();
  await expect(restore).toBeHidden();
  const restored = await (await page.request.get(path)).json();
  expect(restored.inspection.archivedAt).toBeNull();
  expect(restored.rooms).toHaveLength(archived.rooms.length);
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
  test.setTimeout(90_000);
  await login(page);
  await inspection(page);
  let rejectUploads = true;
  await page.route('**/api/v1/orgs/**/inspections/*/batches', (route) =>
    rejectUploads ? route.abort('internetdisconnected') : route.fallback(),
  );
  await captureFiles(page, photo);
  await expect(page.getByRole('status').filter({ hasText: 'op apparaat' }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'op apparaat' }).first()).toBeVisible();
  rejectUploads = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText('Voorbeeldvoorstel', { exact: true })).toBeVisible({
    // An abrupt reload can leave the old tab's 45-second lease behind.
    // Recovery must wait for expiry rather than steal another live tab's lease.
    timeout: 65_000,
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
  await page.getByRole('button', { name: /Inspectie (starten|hervatten)/ }).click();
  const camera = page.getByRole('dialog', { name: 'Inspectie opnemen', exact: true });
  await expect(camera.getByRole('button', { name: 'Microfoon dempen', exact: true })).toBeVisible({
    timeout: 10000,
  });
  await page.waitForTimeout(2200);
  await camera.getByRole('button', { name: 'Microfoon dempen', exact: true }).click();
  await camera.getByRole('button', { name: 'Gereed', exact: true }).click();
  await expect(page.locator('audio')).toBeVisible({ timeout: 15000 });
  await page.reload();
  await expect(page.getByText('Spraaknotitie · intern')).toBeVisible();
  const url = await page.locator('audio').getAttribute('src');
  const response = await page.request.get(url!);
  expect(response.ok()).toBeTruthy();
  expect((await response.body()).length).toBeGreaterThan(100);
});

test('planning and agreements are inline and manual time inputs are absent', async ({ page }) => {
  await login(page);
  await inspection(page);
  const iid = page.url().match(/inspections\/([^/]+)/)![1];
  const me = await (await page.request.get('/api/v1/me')).json();
  const path = `/api/v1/orgs/${me.organisations[0].id}/inspections/${iid}`;
  await page.getByRole('link', { name: 'Dossier', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Inspecteur', { exact: true }).selectOption(me.user.id);
  await page.getByLabel('Externe zaakreferentie', { exact: true }).fill('AUTO-42');
  await page.getByRole('button', { name: 'Planning bewaren', exact: true }).click();
  await page.getByRole('button', { name: 'Afspraak toevoegen', exact: true }).click();
  await page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Afspraak bewaren', exact: true }) })
    .getByRole('textbox', { name: 'Afspraak', exact: true })
    .fill('Bewoner verwijdert losse kast');
  await page.getByLabel('Verantwoordelijk', { exact: true }).selectOption('resident');
  await page.getByRole('button', { name: 'Afspraak bewaren', exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get(path)).json()).agreements.length)
    .toBe(1);
  await expect(page.getByRole('button', { name: 'Tijdmeting', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Opnemen (minuten)', { exact: true })).toHaveCount(0);
  const result = await (await page.request.get(path)).json();
  expect(result.inspection.externalReference).toBe('AUTO-42');
});

test('native login consent survives the SSO return path and can be cancelled', async ({ page }) => {
  await login(page);
  const request = 'a'.repeat(64);
  await page.goto(`/app?mobileRequest=${request}`);
  await expect(
    page.getByRole('heading', { name: 'Mobiele app koppelen', exact: true }),
  ).toBeVisible();
  // Identity providers return to /app; the original request is tab-scoped.
  await page.goto('/app');
  await expect(
    page.getByRole('button', { name: 'Deze appaanmelding bevestigen', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Annuleren', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inspecties', exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('satvey-mobile-request'))).toBeNull();
});

test('room dialog selects type, suggests editable names and exposes a rename pencil', async ({
  page,
}, info) => {
  await login(page);
  const me = await (await page.request.get('/api/v1/me')).json(),
    base = `/api/v1/orgs/${me.organisations[0].id}`;
  const original = await createTestFormat(page, base);
  const revision = await (
    await page.request.post(`${base}/formats/${original.id}/revisions`, { headers, data: {} })
  ).json();
  const format = await (await page.request.get(`${base}/formats/${revision.id}`)).json();
  const bathroom = format.scopes.find((scope: { property: boolean }) => !scope.property);
  const kitchen = {
    ...bathroom,
    id: randomUUID(),
    name: 'Keuken',
    repeatable: false,
    normRoom: 'Keuken',
    required: false,
    questions: bathroom.questions.map((question: object) => ({ ...question, id: randomUUID() })),
  };
  const toilet = {
    ...kitchen,
    id: randomUUID(),
    name: 'Toilet',
    normRoom: 'Toilet',
    questions: kitchen.questions.map((question: object) => ({ ...question, id: randomUUID() })),
  };
  format.scopes.push(kitchen, toilet);
  const saved = await page.request.put(`${base}/formats/${format.id}`, { headers, data: format });
  expect(saved.ok()).toBe(true);
  expect(
    (
      await page.request.post(`${base}/formats/${format.id}/publish`, {
        headers,
        data: { revision: (await saved.json()).revision },
      })
    ).ok(),
  ).toBe(true);
  const property = await createTestProperty(page, base, `Ruimtedialoog ${randomUUID()}`),
    iid = randomUUID(),
    path = `${base}/inspections/${iid}`;
  expect(
    (
      await page.request.post(`${base}/inspections`, {
        headers,
        data: { id: iid, propertyId: property.id, kind: 'pre', formatVersionId: format.id },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/app/inspections/${iid}/capture`);
  await page.getByRole('button', { name: 'Ruimte toevoegen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ruimte toevoegen', exact: true });
  const type = dialog.getByLabel('Ruimtetype', { exact: true }),
    name = dialog.getByRole('textbox', { name: 'Ruimtenaam', exact: true });
  await expect(name).toHaveValue('Badkamer 2');
  await type.selectOption(kitchen.id);
  await expect(name).toHaveValue('Keuken 1');
  await type.selectOption(toilet.id);
  await expect(name).toHaveValue('Toilet 1');
  await name.fill('Gastentoilet');
  await type.selectOption(kitchen.id);
  await expect(name).toHaveValue('Gastentoilet');
  await type.selectOption(toilet.id);
  await name.fill('  ');
  await expect(dialog.getByRole('button', { name: 'Toevoegen', exact: true })).toBeDisabled();
  await name.fill('Gastentoilet');
  await page.screenshot({
    path: `tests/artifacts/room-dialog-add-${info.project.name}.png`,
    scale: 'css',
  });
  await dialog.getByRole('button', { name: 'Toevoegen', exact: true }).click();
  await expect(dialog).toBeHidden();
  const nav = page.getByRole('navigation', { name: 'Ruimtes', exact: true });
  await expect(nav.getByRole('button', { name: 'Gastentoilet Open', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );
  const data = await (await page.request.get(path)).json();
  const room = data.rooms.find((room: { name: string }) => room.name === 'Gastentoilet');
  expect(room.categoryId).toBe(toilet.id);
  const answers = data.answers
    .filter((answer: { roomId: string }) => answer.roomId === room.id)
    .map((answer: { id: string }) => answer.id);
  await nav.getByRole('button', { name: 'Naam wijzigen: Gastentoilet', exact: true }).click();
  const rename = page.getByRole('dialog', { name: 'Ruimtenaam wijzigen', exact: true });
  await expect(rename.getByRole('textbox', { name: 'Ruimtenaam', exact: true })).toBeFocused();
  await rename.getByRole('textbox', { name: 'Ruimtenaam', exact: true }).fill('Toilet bij entree');
  await rename.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(rename).toBeHidden();
  await expect(
    nav.getByRole('button', { name: 'Naam wijzigen: Toilet bij entree', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    nav.getByRole('button', { name: 'Naam wijzigen: Toilet bij entree', exact: true }),
  ).toBeVisible();
  const updated = await (await page.request.get(path)).json();
  expect(updated.rooms.find((value: { id: string }) => value.id === room.id).categoryId).toBe(
    toilet.id,
  );
  expect(
    updated.answers
      .filter((answer: { roomId: string }) => answer.roomId === room.id)
      .map((answer: { id: string }) => answer.id),
  ).toEqual(answers);
  for (const expected of ['Keuken 1', 'Keuken 2']) {
    await page.getByRole('button', { name: 'Ruimte toevoegen', exact: true }).click();
    await type.selectOption(kitchen.id);
    await expect(name).toHaveValue(expected);
    await dialog.getByRole('button', { name: 'Toevoegen', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      nav.getByRole('button', { name: `Naam wijzigen: ${expected}`, exact: true }),
    ).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({
    path: `tests/artifacts/room-dialog-renamed-${info.project.name}.png`,
    scale: 'css',
  });
});

test('branding buttons fit their labels on desktop and landscape tablet', async ({
  page,
}, info) => {
  await login(page);
  await page.goto('/app/settings?tab=organisation');
  const form = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Organisatie en huisstijl', exact: true }) });
  for (const width of [1440, 1194]) {
    await page.setViewportSize({ width, height: 834 });
    await expect(form).toBeVisible();
    const bounds = await form.boundingBox();
    for (const label of ['Satvey-kleur herstellen', 'Voorbeeldknop', 'Rapportidentiteit bewaren']) {
      const button = form.getByRole('button', { name: label, exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box!.width).toBeLessThan(Math.min(350, bounds!.width * 0.75));
    }
    await page.screenshot({
      path: `tests/artifacts/room-dialog-branding-${width}-${info.project.name}.png`,
      scale: 'css',
    });
  }
});

test('organisation logo picker previews, validates and saves the chosen image', async ({
  page,
}, info) => {
  await login(page);
  await page.goto('/app/settings?tab=organisation');
  const form = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Organisatie en huisstijl', exact: true }) });
  const input = form.getByLabel('Organisatielogo uploaden', { exact: true });
  const choose = form.getByRole('button', { name: /^Logo (kiezen|vervangen)$/ });
  await expect(choose).toBeVisible();
  await expect(input).toBeHidden();
  const picker = page.waitForEvent('filechooser');
  await choose.click();
  await (await picker).setFiles({ ...photo, name: 'organisatie-logo.png' });
  await expect(form.getByRole('img', { name: 'Organisatielogo', exact: true })).toBeVisible();
  await expect(form.getByRole('status')).toHaveText('organisatie-logo.png');
  await expect(choose).toHaveText('Logo vervangen');
  expect(
    await form
      .getByRole('img', { name: 'Organisatielogo', exact: true })
      .evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).toBeGreaterThan(0);
  const save = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/report-identity') && response.request().method() === 'PUT',
    );
  const saved = save();
  await form.getByRole('button', { name: 'Rapportidentiteit bewaren', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(form.getByRole('img', { name: 'Organisatielogo', exact: true })).toBeVisible();
  await input.setInputFiles({
    name: 'te-groot.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(1048577),
  });
  await expect(form.getByRole('alert')).toContainText('Maximaal 1 MiB');
  await expect(form.getByRole('img', { name: 'Organisatielogo', exact: true })).toBeVisible();
  await page.screenshot({
    path: `tests/artifacts/room-dialog-logo-${info.project.name}.png`,
    scale: 'css',
  });
  await form.getByRole('button', { name: 'Logo verwijderen', exact: true }).click();
  await expect(form.getByRole('img', { name: 'Organisatielogo', exact: true })).toHaveCount(0);
  await expect(choose).toHaveText('Logo kiezen');
  const removed = save();
  await form.getByRole('button', { name: 'Rapportidentiteit bewaren', exact: true }).click();
  expect((await removed).ok()).toBe(true);
  await page.reload();
  await expect(form.getByRole('button', { name: 'Logo kiezen', exact: true })).toBeVisible();
});
