import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, json, reportPDF, uuid, setAccountIdentity } from './api';
afterEach(() => {
  vi.unstubAllGlobals();
  setAccountIdentity('');
});

describe('authenticated transport', () => {
  it('binds organisation requests to the signed-in identity but keeps account discovery available', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } })),
      );
    vi.stubGlobal('fetch', fetcher);
    setAccountIdentity('original-user');
    await api('/orgs/org/inspections', json('POST', {}));
    expect(fetcher.mock.calls[0][1].headers.get('X-Satvey-User')).toBe('original-user');
    await api('/me');
    expect(fetcher.mock.calls[1][1].headers.has('X-Satvey-User')).toBe(false);
  });
  it('sends same-origin cookies and the mutation request header', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    await api('/items', json('POST', { title: 'test' }));
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('/api/v1/items');
    expect(options.credentials).toBe('same-origin');
    expect(options.headers.get('X-Satvey-Request')).toBe('1');
    expect(options.headers.get('Content-Type')).toBe('application/json');
  });
  it('signals session expiration without exposing a non-JSON response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('proxy failure', { status: 401 })),
    );
    const listener = vi.fn();
    window.addEventListener('satvey-auth-expired', listener);
    await expect(api('/me')).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('satvey-auth-expired', listener);
  });
  it('rejects a successful response that is not a PDF', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } })),
    );
    await expect(reportPDF('/report')).rejects.toThrow('PDF');
  });
  it('generates valid unique media identities', () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuid()).not.toBe(uuid());
  });
});
