import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('search navigates to a matching component', async ({ page }) => {
  await page.goto('/design-system');
  await page.getByRole('button', { name: /^Search the design system/ }).click();
  await page.getByRole('textbox', { name: 'Search the design system' }).fill('buttons');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Buttons/ })
    .click();
  await expect(page).toHaveURL(/components\/buttons/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('A confident next step.');
});

test('mobile navigation opens, navigates, and restores focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/design-system');
  const trigger = page.getByRole('button', { name: 'Open navigation' });
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole('dialog').getByRole('link', { name: 'Colors', exact: true }).click();
  await expect(page).toHaveURL(/foundations\/colors/);
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('form selection, validation, and recovery', async ({ page }) => {
  await page.goto('/design-system/components/forms');
  await page.getByRole('combobox', { name: 'Room', exact: true }).click();
  await page.getByRole('option', { name: 'Kitchen', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Room', exact: true })).toHaveText('Kitchen');
  await page.getByRole('button', { name: 'Validate sample' }).click();
  const field = page.locator('form').getByRole('textbox', { name: /Property name/ });
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Enter a property name to continue.')).toBeVisible();
  await field.fill('Willow House');
  await page.getByRole('button', { name: 'Validate sample' }).click();
  await expect(
    page.getByText('Form validation preview complete. No property was created.', { exact: true }),
  ).toBeVisible();
  await expect(field).not.toHaveAttribute('aria-invalid', 'true');
});

test('code views and real loading feedback work', async ({ page }) => {
  await page.goto('/design-system/components/buttons');
  await page.getByRole('tab', { name: 'Code', exact: true }).first().click();
  await expect(page.getByRole('tabpanel').first()).toContainText('<Button');
  await page.getByRole('tab', { name: 'Preview', exact: true }).first().click();
  await page.getByRole('button', { name: 'Try loading', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saving…', exact: true }).first()).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Try loading', exact: true })).toBeEnabled();
});

test('table pagination and tabs filter sample data', async ({ page }) => {
  await page.goto('/design-system/components/data-display');
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Cedar Cottage', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'In progress', exact: true }).click();
  await expect(page.getByText('Page 1 of 1')).toBeVisible();
  await expect(page.getByText('Elm Apartments', { exact: true })).toBeVisible();
});

test('dialogs retain focus and confirmation starts on the safe action', async ({ page }) => {
  await page.goto('/design-system/components/overlays');
  const trigger = page.getByRole('button', { name: 'Open dialog', exact: true });
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  expect(
    await page.evaluate(() =>
      document.querySelector('[role="dialog"]')?.contains(document.activeElement),
    ),
  ).toBeTruthy();
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(audit.violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.getByRole('button', { name: 'Delete sample', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Keep finding' })).toBeFocused();
  await page.getByRole('button', { name: 'Keep finding' }).click();
  await expect(page.getByRole('alertdialog')).not.toBeVisible();
});

test('menus, popovers, and keyboard tooltips provide context', async ({ page }) => {
  await page.goto('/design-system/components/overlays');
  await page.getByRole('button', { name: 'Finding actions' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Edit sample' }).click();
  await expect(page.getByText('Menu interaction preview.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'About AI assistance' }).click();
  await expect(page.getByRole('heading', { name: 'Your expertise, supported.' })).toBeVisible();
  await page.getByRole('button', { name: 'Close popover' }).click();
  await page.getByRole('button', { name: 'More about this example' }).focus();
  await expect(page.getByRole('tooltip')).toContainText('A little context');
});

test('mock finding review and simulated dictation stay interactive', async ({ page }) => {
  await page.goto('/design-system/patterns/inspection');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: /Finding title/ }).fill('Light scuffing near entrance');
  await page.getByRole('button', { name: 'Save sample' }).click();
  await expect(page.getByRole('heading', { name: 'Light scuffing near entrance' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve sample' }).click();
  await expect(page.getByText('Inspector approved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset preview' }).click();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.getByText('Dismissed', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Voice & observations' }).click();
  await page.getByRole('button', { name: 'Start demo' }).click();
  await expect(page.getByRole('textbox', { name: /Transcript/ })).toHaveValue(/The living room/);
  await page.getByRole('button', { name: 'Stop demo' }).click();
  await page
    .getByRole('textbox', { name: /Transcript/ })
    .fill('An inspector’s editable sample note.');
  await expect(page.getByRole('textbox', { name: /Transcript/ })).toHaveValue(
    'An inspector’s editable sample note.',
  );
  await page.getByRole('tab', { name: 'Report preview' }).click();
  await expect(page.getByRole('heading', { name: 'Property condition report' })).toBeVisible();
});
