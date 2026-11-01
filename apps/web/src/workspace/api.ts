import { platformFetch, prepareResponseResources, protectedURL } from './platform';
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
let accountIdentity = '';
export function setAccountIdentity(userId: string) {
  accountIdentity = userId;
}
export function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
async function request(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (accountIdentity && path.startsWith('/orgs/') && !headers.has('X-Satvey-User'))
    headers.set('X-Satvey-User', accountIdentity);
  if (options.body && typeof options.body === 'string')
    headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') headers.set('X-Satvey-Request', '1');
  const response = await platformFetch(`/api/v1${path}`, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Verzoek mislukt' }));
    if (response.status === 401) window.dispatchEvent(new Event('satvey-auth-expired'));
    throw new ApiError(response.status, body.error || 'Verzoek mislukt');
  }
  return response;
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await request(path, options);
  if (!response.headers.get('content-type')?.includes('json')) return undefined as T;
  const value = (await response.json()) as T;
  await prepareResponseResources(value, path);
  return value;
}
export async function reportPDF(path: string, reportId?: string) {
  const response = await request(
    `${path}/report/pdf${reportId ? `?reportId=${encodeURIComponent(reportId)}` : ''}`,
    json('POST', {}),
  );
  if (!response.headers.get('content-type')?.includes('application/pdf'))
    throw new Error('De server heeft geen PDF teruggestuurd. Probeer opnieuw.');
  const disposition = response.headers.get('content-disposition') || '';
  let filename = 'satvey-inspectierapport.pdf';
  const encoded = disposition.match(/filename\*=utf-8''([^;]+)/i);
  const plain = disposition.match(/filename="([^"]+)"|filename=([^;]+)/i);
  if (encoded) {
    try {
      filename = decodeURIComponent(encoded[1]);
    } catch {
      /* Keep fallback. */
    }
  } else if (plain) filename = plain[1] || plain[2];
  return { blob: await response.blob(), filename };
}
export async function handoverFile(path: string, id: string, format: 'zip' | 'json' | 'csv') {
  const response = await request(`${path}/handovers/${id}/export?format=${format}`);
  const expected = { zip: 'application/zip', json: 'application/json', csv: 'text/csv' }[format];
  if (!response.headers.get('content-type')?.includes(expected))
    throw new Error('Het overdrachtsbestand kon niet worden ontvangen. Probeer opnieuw.');
  return { blob: await response.blob(), filename: `satvey-overdracht-${id}.${format}` };
}
export const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});
export type * from './types';
import type { Organisation } from './types';
export const can = (org: Organisation, privilege: string) =>
  org.privileges?.includes(privilege) ?? false;
export const mediaURL = (org: string, id: string) =>
  protectedURL(`/api/v1/orgs/${org}/media/${id}`);
