import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const pages = [
  '/design-system',
  '/design-system/foundations/colors',
  '/design-system/foundations/typography',
  '/design-system/foundations/layout',
  '/design-system/foundations/iconography',
  '/design-system/foundations/principles',
  '/design-system/components/buttons',
  '/design-system/components/forms',
  '/design-system/components/data-display',
  '/design-system/components/feedback',
  '/design-system/components/overlays',
  '/design-system/patterns/inspection',
];

for (const route of pages) {
  test(`${route} reflows across phone, tablet, and desktop`, async ({ page }) => {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    for (const width of [320, 375, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
      }));
      expect(
        dimensions.content,
        `Horizontal overflow at ${width}px on ${route}`,
      ).toBeLessThanOrEqual(dimensions.viewport + 1);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
  });

  test(`${route} has no automated WCAG A/AA violations`, async ({ page }) => {
    await page.goto(route);
    await page.evaluate(() => document.fonts.ready);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('tablet landscape, zoom reflow, and reduced motion', async ({ page }) => {
  await page.goto('/design-system');
  await page.setViewportSize({ width: 1180, height: 820 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  // A 720 CSS-pixel viewport represents the reflow width of a 1440px screen at 200% zoom.
  await page.setViewportSize({ width: 720, height: 500 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/design-system/components/feedback');
  const animationDuration = await page
    .getByLabel('Loading property summary example')
    .locator('div')
    .first()
    .evaluate((el) => getComputedStyle(el).animationDuration);
  expect(Number.parseFloat(animationDuration)).toBeLessThan(0.001);
});

test('capture representative responsive layouts', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'One consistent browser for review artifacts.');
  await page.goto('/design-system');
  await page.evaluate(() => document.fonts.ready);
  for (const [label, width] of [
    ['phone', 390],
    ['tablet', 768],
    ['desktop', 1440],
  ] as const) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({ path: `tests/artifacts/overview-${label}.png`, fullPage: true });
  }
});

test('working text stays readable on desktop and phone', async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/design-system/components/forms');
    const input = page.locator('form').getByRole('textbox', { name: 'Property name', exact: true });
    await expect(input).toBeVisible();
    expect(
      await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    const action = page.getByRole('button', { name: 'Validate sample' });
    expect(
      await action.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(14);
    expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    const label = page
      .locator('label')
      .filter({ hasText: /^Property name$/ })
      .first();
    expect(
      await label.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(14);
  }
});
