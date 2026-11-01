import { test, expect, type Page } from '@playwright/test';
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
  const account = await (await page.request.get('/api/v1/me')).json();
  return `/api/v1/orgs/${account.organisations[0].id}`;
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
}

test('reviewed mobile navigation, full-page forms and tablet landscape reflow', async ({
  page,
}, info) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole('button', { name: 'Navigatie openen', exact: true });
  await menu.click();
  const drawer = page.getByRole('dialog', { name: 'Navigatie', exact: true });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('link', { name: 'Instellingen', exact: true }).click();
  await expect(drawer).toBeHidden();
  const sections = page.getByRole('combobox', { name: 'Instellingenonderdelen', exact: true });
  await sections.selectOption('members');
  await page.getByRole('button', { name: 'Lid uitnodigen', exact: true }).click();
  const invitation = page.getByRole('dialog');
  await expect(invitation).toBeVisible();
  const box = await invitation.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(389);
  expect(box!.height).toBeGreaterThanOrEqual(843);
  await noOverflow(page);
  await page.screenshot({
    path: `tests/artifacts/review-invitation-mobile-${info.project.name}.png`,
  });
  await invitation.getByRole('button', { name: 'Sluiten', exact: true }).click();
  for (const [name, url] of [
    ['inspecties', '/app'],
    ['kwaliteitskaders', '/app/norms'],
    ['elementen', '/app/norms?tab=elements'],
    ['sjablonen', '/app/formats'],
    ['analytics', '/app/analytics'],
  ] as const) {
    await page.goto(url);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await noOverflow(page);
    if (name === 'kwaliteitskaders')
      await expect(page.getByRole('combobox', { name: 'Kwaliteitskadersmodule' })).toBeVisible();
    if (name === 'sjablonen')
      await expect(
        page.getByRole('button', { name: 'Inspectiesjabloon toevoegen', exact: true }),
      ).toHaveCount(0);
    await page.screenshot({
      path: `tests/artifacts/review-${name}-mobile-${info.project.name}.png`,
      fullPage: info.project.name !== 'mobile-safari',
      scale: 'css',
    });
    await page.setViewportSize({ width: 1194, height: 834 });
    await noOverflow(page);
    await page.screenshot({
      path: `tests/artifacts/review-${name}-tablet-${info.project.name}.png`,
      fullPage: info.project.name !== 'mobile-safari',
      scale: 'css',
    });
    await page.setViewportSize({ width: 390, height: 844 });
  }
});

test('property picker appends pages without resetting its scroll and resets for search', async ({
  page,
}) => {
  await login(page);
  const rows = Array.from({ length: 56 }, (_, index) => ({
    id: randomUUID(),
    address: `Scrollstraat ${index + 1}`,
    objectNumber: `TEST-${index + 1}`,
    postcode: '1234 AB',
    city: 'Utrecht',
    linkState: 'linked',
    active: true,
  }));
  await page.route(/\/api\/v1\/orgs\/[^/]+\/properties\?/, async (route) => {
    const params = new URL(route.request().url()).searchParams,
      p = Number(params.get('page') || 1),
      q = params.get('q') || '';
    const list = q ? rows.filter((row) => row.address === q) : rows;
    await route.fulfill({
      json: { items: list.slice((p - 1) * 25, p * 25), total: list.length, page: p, pageSize: 25 },
    });
  });
  await page.getByRole('button', { name: 'Inspectie toevoegen', exact: true }).click();
  const list = page.getByRole('list', { name: 'Gevonden woningen' });
  await expect(list.getByRole('button')).toHaveCount(25);
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(list.getByRole('button')).toHaveCount(50);
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(list.getByRole('button')).toHaveCount(56);
  await expect(
    page.getByRole('dialog').getByRole('button', { name: /^(Volgende|Vorige) pagina$/ }),
  ).toHaveCount(0);
  await page.getByLabel('Zoek woning', { exact: true }).fill('Scrollstraat 56');
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(list).toContainText('Scrollstraat 56');
});

test('dossier uses inline planning and agreements; reports and analytics stay responsive', async ({
  page,
}, info) => {
  const base = await login(page),
    format = await createTestFormat(page, base),
    property = await createTestProperty(page, base, `Reviewstraat ${randomUUID()}`),
    iid = randomUUID();
  expect(
    (
      await page.request.post(`${base}/inspections`, {
        headers,
        data: { id: iid, propertyId: property.id, kind: 'pre', formatVersionId: format.id },
      })
    ).ok(),
  ).toBe(true);
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1194, height: 834 },
  ]) {
    await page.setViewportSize(viewport);
    for (const stage of ['capture', 'review', 'report', 'dossier']) {
      await page.goto(`/app/inspections/${iid}/${stage}`);
      await expect(
        page.getByRole('heading', { name: property.address, exact: true, level: 1 }),
      ).toBeVisible();
      await noOverflow(page);
      if (viewport.width === 390) {
        const heading = await page
          .getByRole('heading', { name: property.address, exact: true, level: 1 })
          .boundingBox();
        const steps = await page
          .getByRole('navigation', { name: 'Inspectiestappen', exact: true })
          .boundingBox();
        expect(steps!.y - heading!.y - heading!.height).toBeLessThan(150);
      }
      if (stage === 'dossier') {
        await expect(
          page.getByRole('heading', { name: 'Bezoek en planning', exact: true }),
        ).toBeVisible();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(
          page.getByRole('button', { name: 'Kwaliteitscontrole aanvragen', exact: true }),
        ).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Tijdmeting', exact: true })).toHaveCount(0);
      }
      await page.screenshot({
        path: `tests/artifacts/review-dossier-${stage}-${viewport.width}-${info.project.name}.png`,
        fullPage: info.project.name !== 'mobile-safari',
        scale: 'css',
      });
    }
  }
  const axe = await new AxeBuilder({ page })
    .include('#workspace')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
});

test('tablet scoring editor stores independent responsibilities and per-score references', async ({
  page,
}, info) => {
  const base = await login(page);
  await page.setViewportSize({ width: 1194, height: 834 });
  const created = await (
    await page.request.post(`${base}/norms`, {
      headers,
      data: { name: `Scoring ${randomUUID()}`, baseline: true },
    })
  ).json();
  await page.goto(`/app/norms?version=${created.id}`);
  await page.getByRole('checkbox', { name: 'Scoreschaal 1–6 gebruiken', exact: true }).check();
  for (let score = 1; score <= 6; score++) {
    await page
      .getByLabel(`Omschrijving score ${score}`, { exact: true })
      .fill(`Klantomschrijving conditie ${score}`);
    await page
      .getByLabel(`Uitkomst score ${score}`, { exact: true })
      .selectOption(score <= 3 ? 'acceptable' : 'unacceptable');
  }
  await page.getByLabel('Wie herstelt bij score 4?', { exact: true }).selectOption('corporation');
  await page.getByLabel('Wie betaalt bij score 4?', { exact: true }).selectOption('resident');
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
    'base64',
  );
  await page
    .getByLabel('Referentiebestand score 4 toevoegen', { exact: true })
    .setInputFiles({ name: 'score-4.png', mimeType: 'image/png', buffer: image });
  await expect(page.getByLabel('Toelichting referentie', { exact: true })).toBeVisible();
  await page
    .getByLabel('Toelichting referentie', { exact: true })
    .fill('Zichtbaar voorbeeld bij score vier');
  await page.getByRole('button', { name: 'Concept opslaan', exact: true }).click();
  await expect(page.getByText('Concept opgeslagen', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Wie herstelt bij score 4?', { exact: true })).toHaveValue(
    'corporation',
  );
  await expect(page.getByLabel('Wie betaalt bij score 4?', { exact: true })).toHaveValue(
    'resident',
  );
  const saved = await (await page.request.get(`${base}/norms/${created.id}`)).json();
  expect(saved.rules[0].scoreLevels).toHaveLength(6);
  expect(saved.rules[0].scoreLevels[3].references[0].caption).toBe(
    'Zichtbaar voorbeeld bij score vier',
  );
  await noOverflow(page);
  await page.screenshot({
    path: `tests/artifacts/review-score-editor-tablet-${info.project.name}.png`,
    fullPage: info.project.name !== 'mobile-safari',
    scale: 'css',
  });
});
