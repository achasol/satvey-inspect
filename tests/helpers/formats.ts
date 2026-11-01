import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

export const headers = { 'X-Satvey-Request': '1' };
export async function createTestProperty(page: Page, base: string, address: string) {
  const source = randomUUID(),
    remote = randomUUID();
  const saved = await page.request.post(`${base}/property-sources`, {
    headers,
    data: {
      id: source,
      name: `E2E Property Source ${source}`,
      administration: source,
      kind: 'csv',
      enabled: true,
    },
  });
  expect(saved.ok()).toBe(true);
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const csv = `sourceObjectId,objectNumber,address,postcode,city,buildYear\n${remote},VHE-${remote},${quote(address)},1234 AB,Utrecht,1980\n`;
  const preview = await (
    await page.request.post(`${base}/property-sources/${source}/imports`, {
      headers,
      data: { csv },
    })
  ).json();
  expect(preview.errors).toEqual([]);
  expect(
    (
      await page.request.post(`${base}/property-sources/${source}/imports/${preview.id}/confirm`, {
        headers,
        data: {},
      })
    ).ok(),
  ).toBe(true);
  const catalog = await (await page.request.get(`${base}/properties?q=${remote}`)).json();
  expect(catalog.items).toHaveLength(1);
  return catalog.items[0] as {
    id: string;
    sourceId: string;
    sourceObjectId: string;
    address: string;
    revision: number;
  };
}
export async function createTestFormat(page: Page, base: string, normId?: string, quality = false) {
  if (!normId) {
    const res = await page.request.post(`${base}/norms`, {
      headers,
      data: { name: `E2E Norms ${randomUUID()}`, baseline: true },
    });
    expect(res.ok()).toBe(true);
    const norm = await res.json();
    normId = norm.id;
    expect(
      (
        await page.request.post(`${base}/norms/${norm.id}/publish`, {
          headers,
          data: { revision: 1 },
        })
      ).ok(),
    ).toBe(true);
  }
  const res = await page.request.post(`${base}/formats`, {
    headers,
    data: { name: `E2E Format ${randomUUID()}`, kind: 'pre', normVersionId: normId },
  });
  expect(res.ok()).toBe(true);
  const created = await res.json();
  const doc = await (await page.request.get(`${base}/formats/${created.id}`)).json();
  const norm = await (await page.request.get(`${base}/norms/${normId}`)).json();
  const property = {
    id: randomUUID(),
    name: 'Woning algemeen',
    normRoom: 'Woning algemeen',
    property: true,
    required: false,
    repeatable: false,
    questions: [],
  };
  const question = {
    id: randomUUID(),
    title: quality ? 'Vochtsporen beoordelen' : 'Overzicht vastgelegd?',
    kind: quality ? 'quality' : 'boolean',
    required: true,
    instruction: quality
      ? 'Beschrijf eventuele vochtsporen.'
      : 'Maak een overzichtsfoto van de ruimte.',
    talkingPrompt: 'Beschrijf de wanden, vloer en eventuele beschadigingen.',
    ruleId: quality ? norm.rules[0].id : '',
    elementId: '',
    choices: [],
    unit: '',
    evidence: quality ? 'statement' : 'photo',
    minPhotos: quality ? 0 : 1,
  };
  doc.signingPolicy = 'legacy'; // Signing-policy behavior has its own journey.
  doc.scopes = [
    property,
    {
      id: randomUUID(),
      name: 'Badkamer',
      normRoom: 'Badkamer',
      property: false,
      required: true,
      repeatable: true,
      questions: [question],
    },
  ];
  expect((await page.request.put(`${base}/formats/${doc.id}`, { headers, data: doc })).ok()).toBe(
    true,
  );
  expect(
    (
      await page.request.post(`${base}/formats/${doc.id}/publish`, {
        headers,
        data: { revision: 2 },
      })
    ).ok(),
  ).toBe(true);
  return { ...doc, question };
}
