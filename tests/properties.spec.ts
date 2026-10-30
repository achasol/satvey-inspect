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

test('administrator imports a catalog and inspector selects a source identity', async ({
  page,
}) => {
  const base = await login(page),
    unique = randomUUID(),
    sourceName = `E2E Property Source ${unique}`;
  const format = await createTestFormat(page, base);
  await page.goto('/app/settings?tab=properties');
  await page.getByRole('button', { name: 'Vastgoedbron toevoegen', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^Naam vastgoedbron/).fill(sourceName);
  await dialog.getByLabel(/^Bronadministratie/).fill(unique);
  await dialog.getByRole('button', { name: 'Vastgoedbron bewaren', exact: true }).click();
  await expect(dialog).toBeHidden();
  const sourceCard = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: sourceName, exact: true }) });
  await sourceCard.getByRole('button', { name: 'CSV importeren', exact: true }).click();
  dialog = page.getByRole('dialog');
  const address = `Catalogusstraat ${unique}`;
  await dialog.getByLabel('CSV-bestand', { exact: true }).setInputFiles({
    name: 'vastgoed.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      `sourceObjectId,objectNumber,address,postcode,city,buildYear,area,areaType,areaUnit\n${unique},VHE-${unique},${address},1234 AB,Utrecht,1982,75.5,GO,m2\n`,
    ),
  });
  await dialog.getByRole('button', { name: 'Bestand valideren', exact: true }).click();
  await expect(dialog).toContainText('1 woningen: 1 nieuw, 0 gewijzigd, 0 ongewijzigd.');
  await dialog.getByRole('button', { name: 'Import bevestigen', exact: true }).click();
  await expect(dialog.getByText('Import bevestigd.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Sluiten', exact: true }).click();
  await page.goto('/app');
  await page.getByRole('button', { name: 'Inspectie toevoegen', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel(/^Adres/)).toHaveCount(0);
  await expect(dialog.getByLabel('Inspectieformat', { exact: true })).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Deze woning gebruiken', exact: true }),
  ).toHaveCount(0);
  await dialog.getByLabel('Zoek woning', { exact: true }).fill(unique);
  await dialog
    .getByRole('list', { name: 'Gevonden woningen' })
    .getByRole('button')
    .filter({ hasText: address })
    .click();
  await expect(dialog.getByLabel('Zoek woning', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('region', { name: 'Gekozen woning' })).toContainText('1982');
  await dialog.getByLabel('Inspectieformat', { exact: true }).selectOption(format.id);
  await dialog.getByRole('button', { name: 'Vorige stap', exact: true }).click();
  await expect(dialog.getByLabel('Inspectieformat', { exact: true })).toHaveCount(0);
  const selected = dialog
    .getByRole('list', { name: 'Gevonden woningen' })
    .getByRole('button')
    .filter({ hasText: address });
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  await selected.click();
  await expect(dialog.getByLabel('Inspectieformat', { exact: true })).toHaveValue(format.id);
  await dialog.getByRole('button', { name: 'Aanmaken en opnemen', exact: true }).click();
  await expect(page.getByRole('heading', { name: address, exact: true })).toBeVisible();
  const path = `${base}/inspections/${page.url().match(/inspections\/([^/]+)/)![1]}`;
  const dossier = await (await page.request.get(path)).json();
  expect(dossier.inspection.propertySnapshot.sourceObjectId).toBe(unique);
  expect(dossier.inspection.propertySnapshot.linkState).toBe('linked');
  expect(dossier.inspection.propertySnapshot.area).toBe(75.5);
});

test('provisional inspection requires administrator link and explicitly adopts later changes', async ({
  page,
}) => {
  const base = await login(page),
    unique = randomUUID(),
    address = `Teststraat ${unique}`;
  const property = await createTestProperty(page, base, address),
    format = await createTestFormat(page, base);
  await page.getByRole('button', { name: 'Inspectie toevoegen', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Voorlopige woning aanmaken', exact: true }).click();
  const provisionalAddress = `Voorlopig ${unique}`;
  await expect(dialog.getByLabel('Inspectieformat', { exact: true })).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Deze woning gebruiken', exact: true }),
  ).toBeDisabled();
  const creations: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      [base + '/properties', base + '/inspections'].some((path) => request.url().endsWith(path))
    )
      creations.push(request.url());
  });
  await dialog.getByLabel(/^Adres/).fill(provisionalAddress);
  await dialog.getByText('Adresdetails (optioneel)', { exact: true }).click();
  await dialog.getByLabel('Postcode', { exact: true }).fill('2311 AB');
  await dialog.getByLabel('Plaats', { exact: true }).fill('Leiden');
  await dialog.getByLabel(/^Adres/).press('Enter');
  await expect(
    dialog.getByRole('heading', { name: 'Woning en inspectieformat', exact: true }),
  ).toBeFocused();
  await expect(dialog.getByRole('region', { name: 'Gekozen woning' })).toContainText(
    provisionalAddress,
  );
  await expect(dialog.getByRole('region', { name: 'Gekozen woning' })).toContainText('Leiden');
  await expect(dialog.getByLabel('Zoek woning', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('Inspectieformat', { exact: true }).selectOption(format.id);
  await dialog.getByText('Afspraak toevoegen (optioneel)', { exact: true }).click();
  await dialog.getByLabel('Afspraak (optioneel)', { exact: true }).fill('2026-11-16T10:30');
  expect(creations).toEqual([]);
  await dialog.getByRole('button', { name: 'Vorige stap', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Woning kiezen', exact: true })).toBeFocused();
  await expect(dialog.getByLabel(/^Adres/)).toHaveValue(provisionalAddress);
  await expect(dialog.getByLabel('Postcode', { exact: true })).toHaveValue('2311 AB');
  await expect(dialog.getByLabel('Plaats', { exact: true })).toHaveValue('Leiden');
  await expect(dialog.getByLabel('Inspectieformat', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Deze woning gebruiken', exact: true }).click();
  await expect(dialog.getByLabel('Inspectieformat', { exact: true })).toHaveValue(format.id);
  await expect(dialog.getByLabel('Afspraak (optioneel)', { exact: true })).toHaveValue(
    '2026-11-16T10:30',
  );
  expect(creations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  const wizardAxe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(wizardAxe.violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Aanmaken en opnemen', exact: true }).click();
  await expect(page.getByRole('heading', { name: provisionalAddress, exact: true })).toBeVisible();
  const iid = page.url().match(/inspections\/([^/]+)/)![1],
    path = `${base}/inspections/${iid}`;
  const blocked = await page.request.post(`${path}/report`, { headers, data: {} });
  expect(blocked.status()).toBe(422);
  expect((await blocked.json()).error).toContain('Koppel de voorlopige woning');
  await page.getByRole('link', { name: 'Woning koppelen', exact: true }).click();
  await page.getByLabel('Zoek voorlopige woning', { exact: true }).fill(unique);
  await page
    .getByRole('region', { name: 'Vastgoedkoppeling', exact: true })
    .getByRole('list', { name: 'Gevonden woningen' })
    .last()
    .getByRole('button')
    .filter({ hasText: provisionalAddress })
    .click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Zoek bronwoning', { exact: true }).fill(property.sourceObjectId);
  await dialog
    .getByRole('list', { name: 'Gevonden woningen' })
    .getByRole('button')
    .filter({ hasText: property.address })
    .click();
  await dialog.getByRole('button', { name: 'Bronkoppeling bevestigen', exact: true }).click();
  await expect(dialog).toBeHidden();
  const linked = await (await page.request.get(path)).json();
  expect(linked.inspection.propertyId).toBe(property.id);
  expect(linked.inspection.propertySnapshot.linkState).toBe('linked');
  const preview = await (
    await page.request.post(`${base}/property-sources/${property.sourceId}/imports`, {
      headers,
      data: {
        csv: `sourceObjectId,address,buildYear\n${property.sourceObjectId},Nieuw ${unique},1999\n`,
      },
    })
  ).json();
  expect(preview.errors).toEqual([]);
  expect(
    (
      await page.request.post(
        `${base}/property-sources/${property.sourceId}/imports/${preview.id}/confirm`,
        { headers, data: {} },
      )
    ).ok(),
  ).toBe(true);
  await page.goto(`/app/inspections/${iid}/capture`);
  await expect(page.getByRole('heading', { name: address, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Brongegevens vergelijken', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('1999');
  await dialog
    .getByRole('button', { name: 'Gegevens overnemen en herbeoordelen', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: `Nieuw ${unique}`, exact: true })).toBeVisible();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
  }
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((v) => ['serious', 'critical'].includes(v.impact || '')),
  ).toEqual([]);
});
