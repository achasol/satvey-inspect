import { captureFiles } from './helpers/capture';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { createTestFormat, createTestProperty, headers } from './helpers/formats';

const photo = {
  name: 'wand.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAF0lEQVR4nGKKygv4z4APMKELAAIAAP//ZS4CHD5TmGgAAAAASUVORK5CYII=',
    'base64',
  ),
};
async function setup(page: Page) {
  await page.route('**/api/v1/orgs/**/inspections/*/batches', async (route) =>
    route.request().method() === 'POST'
      ? route.continue({
          postData: JSON.stringify({ ...route.request().postDataJSON(), analysisProvider: 'mock' }),
        })
      : route.continue(),
  );
  await page.goto('/app');
  await page.getByLabel(/^E-mailadres/).fill(process.env.E2E_EMAIL || 'admin@satvey.local');
  await page.getByRole('button', { name: 'Doorgaan', exact: true }).click();
  await page.getByLabel(/^Wachtwoord/).fill(process.env.E2E_PASSWORD || 'local-inspection-2026');
  await page.getByRole('button', { name: 'Inloggen', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inspecties', exact: true })).toBeVisible();
  const me = await (await page.request.get('/api/v1/me')).json(),
    base = `/api/v1/orgs/${me.organisations[0].id}`;
  const format = await createTestFormat(page, base),
    iid = randomUUID();
  const pid = (await createTestProperty(page, base, `Teststraat ${iid}`)).id;
  expect(
    (
      await page.request.post(`${base}/inspections`, {
        headers,
        data: { id: iid, propertyId: pid, kind: 'pre', formatVersionId: format.id },
      })
    ).ok(),
  ).toBe(true);
  const path = `${base}/inspections/${iid}`,
    initial = await (await page.request.get(path)).json();
  const room = initial.rooms.find((r: { name: string }) => r.name === 'Badkamer'),
    second = randomUUID();
  expect(
    (
      await page.request.post(`${path}/rooms`, {
        headers,
        data: { id: second, name: 'Badkamer 2', categoryId: room.categoryId },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/app/inspections/${iid}/capture`);
  return { path, iid, room: room.id as string, second };
}
async function addPhoto(page: Page) {
  await captureFiles(page, photo);
  await expect(page.getByText('Voorbeeldvoorstel', { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole('link', { name: 'Beoordelen', exact: true }).click();
}
async function draw(page: Page, tool = 'Pijl') {
  const dialog = page.getByRole('dialog'),
    surface = dialog.getByRole('img', { name: 'Tekenvlak', exact: true });
  await dialog.getByRole('button', { name: tool, exact: true }).click();
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  if (
    page.context().browser()?.browserType().name() === 'chromium' &&
    (await page.evaluate(() => navigator.maxTouchPoints > 0))
  ) {
    const touch = await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: box!.x + box!.width * 0.2, y: box!.y + box!.height * 0.25 }],
    });
    for (let step = 1; step <= 10; step++)
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: box!.x + box!.width * (0.2 + (0.55 * step) / 10),
            y: box!.y + box!.height * (0.25 + (0.45 * step) / 10),
          },
        ],
      });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touch.detach();
    return;
  }
  await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.75, box!.y + box!.height * 0.7, { steps: 10 });
  await page.mouse.up();
}

test('photo drawings persist, compare conflicts and appear in report previews', async ({
  page,
}, info) => {
  const { path } = await setup(page);
  await addPhoto(page);
  await expect(page.getByRole('region', { name: 'Badkamer', exact: true })).toBeVisible();
  // Both room sections exist at once; scrolling needs no room-selection click.
  await expect(page.getByRole('region', { name: 'Badkamer 2', exact: true })).toHaveCount(1);
  await page.getByRole('region', { name: 'Badkamer 2', exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Foto bekijken: wand.png', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Pijl', exact: true }),
  ).toBeEnabled();
  const originalViewport = page.viewportSize()!;
  for (const width of [320, 360, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page
        .getByRole('dialog')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    const pen = await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Pen', exact: true })
      .boundingBox();
    expect(pen!.width).toBeGreaterThanOrEqual(48);
    expect(pen!.height).toBeGreaterThanOrEqual(48);
  }
  await page.setViewportSize(originalViewport);
  await draw(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('svg[aria-label="Tekenvlak"] g')).toHaveCount(1);
  await draw(page, 'Cirkel');
  await dialog.getByRole('button', { name: 'Ongedaan maken', exact: true }).click();
  await expect(dialog.locator('svg[aria-label="Tekenvlak"] g')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Opnieuw uitvoeren', exact: true }).click();
  await expect(dialog.locator('svg[aria-label="Tekenvlak"] g')).toHaveCount(2);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: `tests/artifacts/photo-editor-${info.project.name}.png` });
  const server = await (await page.request.get(path)).json(),
    mid = server.media[0].id,
    endpoint = `${path}/media/${mid}/annotations`;
  // Another inspector saves before this editor, producing a real optimistic-concurrency conflict.
  expect(
    (await page.request.put(endpoint, { headers, data: { version: 0, shapes: [] } })).ok(),
  ).toBe(true);
  await dialog.getByRole('button', { name: 'Gereed', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Synchronisatieproblemen' })).toContainText(
    '2 fotomarkeringen',
  );
  await page.getByRole('button', { name: 'Foto bekijken: wand.png', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Fotomarkeringen vergelijken' })).toBeVisible();
  await page.getByRole('button', { name: 'Mijn markeringen verder bewerken', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Gereed', exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(endpoint)).json()).version).toBe(2);
  const stored = await (await page.request.get(endpoint)).json();
  expect(stored.shapes).toHaveLength(2);
  expect(stored.shapes[0].points[0].x).toBeCloseTo(0.2, 1);
  await page.reload();
  await page.getByRole('button', { name: 'Foto bekijken: wand.png', exact: true }).click();
  await expect(page.getByRole('dialog').locator('svg[aria-label="Tekenvlak"] g')).toHaveCount(2);
  await page.getByRole('dialog').getByRole('button', { name: 'Gereed', exact: true }).click();
  const finding = page.getByRole('region', { name: 'Bevinding beoordelen', exact: true });
  await finding
    .getByLabel('Beschrijving', { exact: true })
    .fill('Beschadigde afwerking aan de wand.');
  await finding.getByRole('button', { name: 'Goedkeuren', exact: true }).click();
  await expect(finding.getByText('Goedgekeurd', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Rapport', exact: true }).click();
  await expect(page.getByRole('article').getByText('Gemarkeerd', { exact: true })).toBeVisible();
});

test('annotation drafts survive reload and offline saves remain queued until reconnecting', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { path } = await setup(page);
  await addPhoto(page);
  await page.getByRole('button', { name: 'Foto bekijken: wand.png', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Pen', exact: true }),
  ).toBeEnabled();
  await draw(page, 'Pen');
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const r = indexedDB.open('satvey-workspace');
          r.onsuccess = () => resolve(r.result);
        });
        const drafts = await new Promise<{ shapes?: unknown[] }[]>((resolve) => {
          const r = db.transaction('drafts').objectStore('drafts').getAll();
          r.onsuccess = () => resolve(r.result);
        });
        db.close();
        return drafts.some((d) => d.shapes?.length === 1);
      }),
    )
    .toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Foto bekijken: wand.png', exact: true }).click();
  await expect(page.getByRole('dialog').locator('svg[aria-label="Tekenvlak"] g')).toHaveCount(1);
  let offline = true;
  await page.route('**/media/*/annotations', (route) =>
    route.request().method() === 'PUT' && offline
      ? route.abort('internetdisconnected')
      : route.continue(),
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Gereed', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Synchronisatieproblemen' })).toContainText(
    '1 fotomarkeringen',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Foto bekijken: wand.png', exact: true }).click();
  await expect(page.getByRole('dialog').locator('svg[aria-label="Tekenvlak"] g')).toHaveCount(1);
  await page.getByRole('dialog').getByRole('button', { name: 'Gereed', exact: true }).click();
  offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect
    .poll(async () => (await (await page.request.get(path)).json()).media[0].annotationVersion, {
      timeout: 65_000,
    })
    .toBe(1);
});

test('long camera visits split uploads without requiring a save click', async ({ page }) => {
  const { path } = await setup(page);
  const denyCapture = () =>
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException('Denied', 'NotAllowedError');
        },
      },
    });
  await page.addInitScript(denyCapture);
  await page.evaluate(denyCapture);
  await page.getByRole('button', { name: /Inspectie (starten|hervatten)/ }).click();
  const camera = page.getByRole('dialog', { name: 'Inspectie opnemen', exact: true });
  await expect(camera.getByRole('button', { name: 'Gereed', exact: true })).toBeEnabled();
  await camera
    .getByLabel('Foto toevoegen in camerasessie', { exact: true })
    .setInputFiles(Array.from({ length: 31 }, (_, i) => ({ ...photo, name: `wand-${i}.png` })));
  await expect(camera.getByText(/^1 foto’s/)).toBeVisible();
  await camera.getByRole('button', { name: 'Gereed', exact: true }).click();
  await expect(camera).toBeHidden();
  await expect
    .poll(async () => (await (await page.request.get(path)).json()).media.length, {
      timeout: 25000,
    })
    .toBe(31);
  expect((await (await page.request.get(path)).json()).batches).toHaveLength(2);
});

test('camera fallback saves per room automatically and recovers an interrupted visit', async ({
  page,
}, info) => {
  const { path, room, second } = await setup(page);
  const denyCapture = () =>
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException('Denied', 'NotAllowedError');
        },
      },
    });
  await page.addInitScript(denyCapture);
  await page.evaluate(denyCapture);
  await page.getByRole('button', { name: /Inspectie (starten|hervatten)/ }).click();
  const camera = page.getByRole('dialog', { name: 'Inspectie opnemen', exact: true });
  await expect(camera.getByText(/Cameratoegang geweigerd/)).toBeVisible();
  await camera.getByLabel('Foto toevoegen in camerasessie', { exact: true }).setInputFiles(photo);
  await expect(camera.getByText(/^1 foto’s/)).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: /Inspectie (starten|hervatten)/ }).click();
  await expect(camera.getByText('Eerdere camerasessie hersteld.', { exact: true })).toBeVisible();
  await expect(camera.getByText(/^1 foto’s/)).toBeVisible();
  await camera.getByRole('button', { name: 'Badkamer', exact: true }).click();
  await camera.getByRole('button', { name: 'Badkamer 2', exact: true }).click();
  await expect(camera.getByRole('button', { name: 'Badkamer 2', exact: true })).toBeVisible();
  await expect(camera.getByRole('button', { name: 'Badkamer 2', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(camera.getByRole('button', { name: 'Badkamer 2', exact: true })).toBeEnabled();
  await camera.getByLabel('Foto toevoegen in camerasessie', { exact: true }).setInputFiles(photo);
  await expect(camera.getByText(/^1 foto’s/)).toBeVisible();
  const savedVisit = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('satvey-workspace');
      r.onsuccess = () => resolve(r.result);
    });
    const drafts = await new Promise<unknown[]>((resolve) => {
      const r = db.transaction('drafts').objectStore('drafts').getAll();
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    return drafts;
  });
  expect(savedVisit).toEqual(
    expect.arrayContaining([expect.objectContaining({ roomId: second, files: expect.any(Array) })]),
  );
  await camera.getByRole('button', { name: 'Gereed', exact: true }).click();
  await expect(camera).toBeHidden();
  await expect
    .poll(async () => (await (await page.request.get(path)).json()).media.length, {
      timeout: 20000,
    })
    .toBe(2);
  const current = await (await page.request.get(path)).json();
  expect(current.batches.map((b: { roomId: string }) => b.roomId).sort()).toEqual(
    [room, second].sort(),
  );
  expect(current.batches).toHaveLength(2);
  await page.getByRole('link', { name: 'Beoordelen', exact: true }).click();
  const secondSection = page.getByRole('region', { name: 'Badkamer 2', exact: true });
  await secondSection.scrollIntoViewIfNeeded();
  await expect(
    secondSection.getByRole('button', { name: 'Foto bekijken: wand.png', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `tests/artifacts/scroll-review-${info.project.name}.png`,
    fullPage: true,
  });
});

test('live camera keeps its stream across room changes and stops it on close', async ({
  page,
  context,
}, info) => {
  test.skip(
    info.project.name !== 'chromium',
    'Virtual camera is configured for desktop Chromium; real phones require device testing.',
  );
  await context.grantPermissions(['camera', 'microphone']);
  const { path, room, second } = await setup(page);
  await page.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    (window as unknown as { cameraRequests: number }).cameraRequests = 0;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints?.video) (window as unknown as { cameraRequests: number }).cameraRequests++;
      const result = await original(constraints);
      if (constraints?.video)
        (window as unknown as { cameraTrack: MediaStreamTrack }).cameraTrack =
          result.getVideoTracks()[0];
      return result;
    };
  });
  await page.getByRole('button', { name: /Inspectie (starten|hervatten)/ }).click();
  const camera = page.getByRole('dialog', { name: 'Inspectie opnemen', exact: true }),
    shutter = camera.getByRole('button', { name: 'Foto vastleggen', exact: true });
  await expect(shutter).toBeEnabled({ timeout: 15000 });
  await page.waitForTimeout(2200);
  await shutter.click();
  await expect(camera.getByText(/^1 foto’s/)).toBeVisible();
  await camera.getByRole('button', { name: 'Badkamer', exact: true }).click();
  await camera.getByRole('button', { name: 'Badkamer 2', exact: true }).click();
  await expect(shutter).toBeEnabled();
  expect(
    await page.evaluate(() => (window as unknown as { cameraRequests: number }).cameraRequests),
  ).toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { cameraTrack: MediaStreamTrack }).cameraTrack.readyState,
    ),
  ).toBe('live');
  await page.waitForTimeout(2200);
  await shutter.click();
  await expect(camera.getByText(/^1 foto’s/)).toBeVisible();
  await page.screenshot({ path: 'tests/artifacts/live-camera-chromium.png' });
  await camera.getByRole('button', { name: 'Gereed', exact: true }).click();
  await expect(camera).toBeHidden();
  expect(
    await page.evaluate(
      () => (window as unknown as { cameraTrack: MediaStreamTrack }).cameraTrack.readyState,
    ),
  ).toBe('ended');
  await expect
    .poll(
      async () =>
        (await (await page.request.get(path)).json()).media.filter(
          (m: { kind: string }) => m.kind === 'photo',
        ).length,
      {
        timeout: 20000,
      },
    )
    .toBe(2);
  const current = await (await page.request.get(path)).json();
  expect(current.media.filter((m: { kind: string }) => m.kind === 'audio')).toHaveLength(2);
  expect(current.batches.map((b: { roomId: string }) => b.roomId).sort()).toEqual(
    [room, room, second, second].sort(),
  );
});
