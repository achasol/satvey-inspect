import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export async function captureFiles(
  page: Page,
  files:
    | { name: string; mimeType: string; buffer: Buffer }
    | { name: string; mimeType: string; buffer: Buffer }[],
) {
  // Exercise the actual device-camera fallback after permission refusal. No
  // hidden legacy upload controls or database writes are used by this helper.
  const unavailable = () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException('Denied for fallback test', 'NotAllowedError');
        },
      },
    });
  };
  await page.addInitScript(unavailable);
  await page.evaluate(unavailable);
  await page.getByRole('button', { name: /Inspectie (starten|hervatten)/ }).click();
  const camera = page.getByRole('dialog', { name: 'Inspectie opnemen', exact: true });
  await camera.getByLabel('Foto toevoegen in camerasessie', { exact: true }).setInputFiles(files);
  await expect(camera.getByRole('status')).toContainText('Foto op apparaat bewaard');
  await camera.getByRole('button', { name: 'Gereed', exact: true }).click();
  await expect(camera).toBeHidden();
}
