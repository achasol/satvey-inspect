import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { headers } from './helpers/formats';

async function login(
  page: Page,
  email = process.env.E2E_EMAIL || 'admin@satvey.local',
  password = process.env.E2E_PASSWORD || 'local-inspection-2026',
) {
  await page.goto('/app');
  await page.getByLabel(/^E-mailadres/).fill(email);
  await page.getByRole('button', { name: 'Doorgaan', exact: true }).click();
  await page.getByLabel(/^Wachtwoord/).fill(password);
  await page.getByRole('button', { name: 'Inloggen', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inspecties', exact: true })).toBeVisible();
}
async function deliveredLink(request: APIRequestContext, email: string, needle: string) {
  const mail = process.env.MAILPIT_URL;
  if (!mail) throw new Error('Account delivery tests require the isolated SMTP capture service');
  let text = '';
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${mail}/api/v1/search?query=${encodeURIComponent('to:' + email)}`,
        );
        expect(response.ok()).toBe(true);
        const result = await response.json();
        for (const item of result.messages || []) {
          const message = await (await request.get(`${mail}/api/v1/message/${item.ID}`)).json();
          if (message.Text?.includes(needle)) {
            text = message.Text;
            return true;
          }
        }
        return false;
      },
      { timeout: 20000 },
    )
    .toBe(true);
  const link = text.match(/https?:\/\/[^\s]+/)?.[0];
  expect(link).toBeTruthy();
  const url = new URL(link!);
  return url.pathname + url.search + url.hash;
}
test('invitation email creates an account and password recovery revokes its old session', async ({
  page,
  browser,
  request,
}) => {
  await login(page);
  const account = await (await page.request.get('/api/v1/me')).json();
  const email = `account-${randomUUID()}@e2e.invalid`;
  const invited = await page.request.post(
    `/api/v1/orgs/${account.organisations[0].id}/invitations`,
    { headers, data: { email, role: 'inspector' } },
  );
  expect(invited.status()).toBe(201);
  expect((await invited.json()).delivery).toBe('pending');
  const invitation = await deliveredLink(request, email, '/invite?token=');
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const member = await context.newPage();
  try {
    await member.goto(invitation);
    await member.getByLabel(/^Naam/).fill('E2E Account');
    await member.getByLabel('Nieuw wachtwoord').fill('invited-password-2026');
    await member.getByRole('button', { name: 'Uitnodiging accepteren' }).click();
    await expect(member.getByRole('heading', { name: 'Inspecties', exact: true })).toBeVisible();
    const oldContext = await browser.newContext({
      storageState: await context.storageState(),
      baseURL: new URL(page.url()).origin,
    });
    try {
      await member.goto('/forgot-password');
      await member.getByLabel('E-mailadres').fill(email);
      await member.getByRole('button', { name: 'Herstellink versturen' }).click();
      await expect(member.getByRole('status')).toContainText('Als dit e-mailadres');
      const reset = await deliveredLink(request, email, '/reset-password#token=');
      await member.goto(reset);
      await member.getByLabel('Nieuw wachtwoord').fill('recovered-password-2026');
      await member.getByLabel('Wachtwoord herhalen').fill('recovered-password-2026');
      await member.getByRole('button', { name: 'Wachtwoord wijzigen' }).click();
      await expect(member.getByRole('status')).toContainText('gewijzigd');
      expect((await oldContext.request.get('/api/v1/me')).status()).toBe(401);
      await login(member, email, 'recovered-password-2026');
      await member.goto(reset);
      await member.getByLabel('Nieuw wachtwoord').fill('another-password-2026');
      await member.getByLabel('Wachtwoord herhalen').fill('another-password-2026');
      await member.getByRole('button', { name: 'Wachtwoord wijzigen' }).click();
      await expect(member.getByRole('alert')).toContainText('verlopen');
    } finally {
      await oldContext.close();
    }
  } finally {
    await context.close();
  }
});
test('unknown password recovery requests receive the neutral confirmation', async ({ page }) => {
  await page.goto('/forgot-password');
  await page.getByLabel('E-mailadres').fill(`unknown-${randomUUID()}@e2e.invalid`);
  await page.getByRole('button', { name: 'Herstellink versturen' }).click();
  await expect(page.getByRole('status')).toContainText('Als dit e-mailadres');
});
