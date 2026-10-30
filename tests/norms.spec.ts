import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { createTestFormat, createTestProperty } from './helpers/formats';

const email = process.env.E2E_EMAIL || 'admin@satvey.local';
const password = process.env.E2E_PASSWORD || 'local-inspection-2026';
const headers = { 'X-Satvey-Request': '1' };
async function login(page: Page) {
  await page.goto('/app');
  await page.getByLabel(/^E-mailadres/).fill(email);
  await page.getByRole('button', { name: 'Doorgaan', exact: true }).click();
  await page.getByLabel(/^Wachtwoord/).fill(password);
  await page.getByRole('button', { name: 'Inloggen', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inspecties', exact: true })).toBeVisible();
  const account = await (await page.request.get('/api/v1/me')).json();
  return `/api/v1/orgs/${account.organisations[0].id}`;
}
async function noOverflow(page: Page) {
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll('main *')]
      .map((el) => ({
        tag: el.tagName,
        cls: el.className,
        right: el.getBoundingClientRect().right,
        width: el.getBoundingClientRect().width,
      }))
      .filter((el) => el.right > innerWidth + 1),
  }));
  expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width);
}

test('settings tabs separate account, members, roles and SSO while preserving form drafts', async ({
  page,
}, info) => {
  await login(page);
  await page.getByRole('link', { name: 'Instellingen', exact: true }).click();
  const tabs = page.getByRole('navigation', { name: 'Instellingenonderdelen', exact: true });
  await expect(tabs.getByRole('link', { name: 'Account', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByLabel('Huidig wachtwoord', { exact: true })).toBeHidden();
  await expect(page.getByLabel('OIDC issuer URL', { exact: false })).toHaveCount(0);
  await tabs.getByRole('link', { name: 'Rollen en privileges', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rol toevoegen', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lid uitnodigen', exact: true })).toHaveCount(0);
  const loaded = page.waitForResponse(
    (response) => response.url().endsWith('/sso') && response.request().method() === 'GET',
  );
  await tabs.getByRole('link', { name: 'SSO', exact: true }).click();
  await loaded;
  await page.getByLabel(/^Client-ID/).fill('unsaved-settings-tab-draft');
  await tabs.getByRole('link', { name: 'Account', exact: true }).click();
  await tabs.getByRole('link', { name: 'SSO', exact: true }).click();
  await expect(page.getByLabel(/^Client-ID/)).toHaveValue('unsaved-settings-tab-draft');
  await noOverflow(page);
  const axe = await new AxeBuilder({ page })
    .include('#workspace')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({
    path: `tests/artifacts/settings-sso-${info.project.name}.png`,
    fullPage: true,
  });
  await page.reload();
  await expect(tabs.getByRole('link', { name: 'SSO', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('link', { name: 'Normen', exact: true }).click();
  await expect(
    page
      .getByRole('navigation', { name: 'Normenmodule', exact: true })
      .getByRole('link', { name: 'Inspectieformats', exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: 'Hoofdnavigatie', exact: true })
      .getByRole('link', { name: 'Inspectieformats', exact: true }),
  ).toBeVisible();
});

test('inspectors see account settings without organisation-management forms', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.organisations = body.organisations.map((org: { privileges: string[] }) => ({
      ...org,
      roleName: 'Inspecteur',
      privileges: org.privileges.filter((p) => p !== 'settings.manage'),
    }));
    await route.fulfill({ response, json: body });
  });
  await page.goto('/app/settings?tab=sso');
  const tabs = page.getByRole('navigation', { name: 'Instellingenonderdelen', exact: true });
  await expect(tabs.getByRole('link')).toHaveCount(1);
  await expect(tabs.getByRole('link', { name: 'Account', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { name: 'Je account', exact: true })).toBeVisible();
  await expect(page.getByLabel(/^Client-ID/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rol toevoegen', exact: true })).toHaveCount(0);
});

test('custom roles expose privileges and appear in invitation choices', async ({ page }, info) => {
  const base = await login(page);
  await page.getByRole('link', { name: 'Instellingen', exact: true }).click();
  await page.getByRole('link', { name: 'Rollen en privileges', exact: true }).click();
  await page.getByRole('button', { name: 'Rol toevoegen', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const name = `E2E Role ${Date.now()}-${info.project.name}`;
  await dialog.getByLabel(/^Rolnaam/).fill(name);
  await dialog.getByRole('checkbox', { name: 'Normen beheren', exact: true }).check();
  await expect(
    dialog.getByRole('checkbox', { name: 'Normen bekijken', exact: true }),
  ).toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Benchmark bekijken', exact: true }).check();
  await dialog.getByRole('button', { name: 'Rol opslaan' }).click();
  await expect(dialog).toBeHidden();
  const row = page
    .locator('[class*="roleRow"]')
    .filter({ has: page.getByText(name, { exact: true }) });
  await expect(row).toBeVisible();
  await page.getByRole('link', { name: 'Leden en uitnodigingen', exact: true }).click();
  await page.getByRole('button', { name: 'Lid uitnodigen', exact: true }).click();
  await expect(page.getByLabel('Rol', { exact: true }).getByRole('option', { name })).toHaveCount(
    1,
  );
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Rollen en privileges', exact: true }).click();
  await row.getByRole('button', { name: 'Rol bewerken' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Normen beheren', exact: true })).toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Normen bekijken', exact: true }).uncheck();
  await expect(
    dialog.getByRole('checkbox', { name: 'Normen beheren', exact: true }),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole('checkbox', { name: 'Benchmark bekijken', exact: true }),
  ).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Rol opslaan' }).click();
  await expect(row.getByText('Geen privileges', { exact: true })).toBeVisible();
  await noOverflow(page);
  const roles = await (await page.request.get(`${base}/roles`)).json();
  const role = roles.roles.find((r: { name: string }) => r.name === name);
  expect((await page.request.delete(`${base}/roles/${role.id}`, { headers })).ok()).toBe(true);
});

test('quality managers define room elements and link measures to them', async ({ page }, info) => {
  await login(page);
  await page.getByRole('link', { name: 'Normen', exact: true }).click();
  await page.getByRole('link', { name: 'Ruimtes en elementen', exact: true }).click();
  await page.getByRole('button', { name: 'Element toevoegen', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const name = `E2E Element ${Date.now()}-${info.project.name}`;
  await dialog.getByLabel(/^Naam element/).fill(name);
  await dialog.getByLabel('Wat is dit element?', { exact: true }).fill('Mengkraan bij de douche.');
  await dialog.getByRole('checkbox', { name: 'Badkamer', exact: true }).check();
  await dialog
    .getByLabel('Waar moet de AI bij dit element op letten?', { exact: true })
    .fill('Let op lekkage bij de zichtbare aansluiting.');
  await dialog.getByLabel(/^Andere benamingen/).fill('faucet, mengkraan');
  await dialog.getByRole('button', { name: 'Element opslaan', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByLabel('Element zoeken', { exact: true }).fill(name);
  await page.getByLabel('Ruimte filteren', { exact: true }).selectOption('Badkamer');
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByLabel('Ruimte filteren', { exact: true }).selectOption('Keuken');
  await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Normenkaders', exact: true }).click();
  await page.getByRole('button', { name: 'Normenkader toevoegen', exact: true }).click();
  const normName = `E2E Norms ${Date.now()}-${info.project.name}`;
  await dialog.getByLabel(/^Naam normenkader/).fill(normName);
  await dialog.getByRole('button', { name: 'Concept aanmaken', exact: true }).click();
  await expect(page.getByRole('heading', { name: normName, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Maatregelen (12)', exact: true })).toBeVisible();
  await page
    .getByLabel('Element uit de ruimtedefinities', { exact: true })
    .selectOption({ label: name });
  await expect(page.getByLabel('Object of bouwdeel', { exact: true })).toHaveValue(name);
  await expect(
    page.getByLabel("Ruimtes (komma's, * voor alle ruimtes)", { exact: true }),
  ).toHaveValue('Badkamer');
  await page.getByRole('button', { name: 'Concept opslaan', exact: true }).click();
  await expect(page.getByText('Concept opgeslagen', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Object of bouwdeel', { exact: true })).toHaveValue(name);
  await noOverflow(page);
  const axe = await new AxeBuilder({ page })
    .include('#workspace')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({ path: `tests/artifacts/norms-${info.project.name}.png`, fullPage: true });
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Publiceren', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Nieuwe versie maken', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Object of bouwdeel', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Nieuwe versie maken', exact: true }).click();
  await expect(page.getByText(/Versie 2/)).toBeVisible();
  await expect(page.getByLabel('Object of bouwdeel', { exact: true })).toHaveValue(name);
});

test('pinned norms and editable transcripts produce confirmed benchmark results', async ({
  page,
}, info) => {
  const base = await login(page);
  const name = `E2E Norms ${Date.now()}-${info.project.name}`;
  let res = await page.request.post(`${base}/norms`, { headers, data: { name, baseline: true } });
  expect(res.ok()).toBe(true);
  const doc = await res.json();
  doc.rules = [doc.rules[0]];
  doc.rules[0].rooms = ['*'];
  expect(
    (
      await page.request.put(`${base}/norms/${doc.id}`, {
        headers,
        data: { name, rules: doc.rules, revision: 1 },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post(`${base}/norms/${doc.id}/publish`, { headers, data: { revision: 2 } })
    ).ok(),
  ).toBe(true);
  const format = await createTestFormat(page, base, doc.id, true);
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
  await page.getByRole('button', { name: 'Aanmaken en opnemen', exact: true }).click();
  await expect(page.getByRole('heading', { name: address, exact: true })).toBeVisible();
  const iid = page.url().match(/inspections\/([^/]+)/)![1];
  const path = `${base}/inspections/${iid}`;
  const data = await (await page.request.get(path)).json();
  const batch = randomUUID(),
    audio = randomUUID();
  expect(
    (
      await page.request.post(`${path}/batches`, {
        headers,
        data: { id: batch, roomId: data.rooms[0].id, mediaIds: [audio], analysisProvider: 'mock' },
      })
    ).ok(),
  ).toBe(true);
  const wav = Buffer.alloc(48);
  wav.write('RIFF');
  wav.write('WAVEfmt ', 8);
  expect(
    (
      await page.request.put(`${path}/batches/${batch}/media/${audio}`, {
        headers: { ...headers, 'Content-Type': 'audio/wav', 'X-File-Name': 'spraak.wav' },
        data: wav,
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await page.getByText(/Transcript bij spraaknotitie/).click();
  await page
    .getByLabel('Transcript audio', { exact: true })
    .fill('Vochtsporen waargenomen naast de douche. De oorzaak is onbekend.');
  await page.getByRole('button', { name: 'Transcript bewaren en analyseren', exact: true }).click();
  await expect
    .poll(
      async () => {
        const current = await (await page.request.get(path)).json();
        return (
          current.media.find((m: { id: string }) => m.id === audio)?.transcript &&
          current.scopeJobs.every((j: { status: string }) => j.status === 'done')
        );
      },
      { timeout: 20000 },
    )
    .toBeTruthy();
  await page.reload();
  await page.getByRole('link', { name: 'Beoordelen', exact: true }).click();
  for (const finding of await page
    .getByRole('region', { name: 'Bevinding beoordelen', exact: true })
    .all()) {
    await finding.getByRole('button', { name: 'Afwijzen', exact: true }).click();
    await expect(finding.getByText('Afgewezen', { exact: true })).toBeVisible();
  }
  await page.getByText('Vochtsporen beoordelen', { exact: true }).click();
  await page
    .getByRole('group', { name: 'Normoordeel', exact: true })
    .getByRole('button', { name: 'Niet acceptabel', exact: true })
    .click();
  await page
    .getByLabel('Onderbouwing of geschreven waarneming', { exact: true })
    .fill('Inspecteur bevestigt zichtbare vochtsporen.');
  await page.getByRole('button', { name: 'Antwoord bewaren', exact: true }).click();
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
  await page.getByRole('link', { name: 'Rapport', exact: true }).click();
  await expect(
    page
      .getByRole('article', { name: 'Inspectierapport' })
      .getByText('Inspecteur bevestigt zichtbare vochtsporen.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Normen', exact: true }).click();
  await page.getByRole('link', { name: 'Benchmark', exact: true }).click();
  await page.getByLabel('Normversie voor benchmark', { exact: true }).selectOption(doc.id);
  await expect(page.getByRole('table')).toContainText(doc.rules[0].title);
  await expect(
    page.locator('[class*=benchmarkStats]').getByText('0%', { exact: true }),
  ).toBeVisible();
  await noOverflow(page);
});
