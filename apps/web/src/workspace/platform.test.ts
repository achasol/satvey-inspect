import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { collectNativeGarbage } from './nativeStorage';
import {
  loadProtectedResource,
  prepareResponseResources,
  protectedURL,
  rememberSession,
} from './platform';

const storage = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./nativeStorage', () => ({
  nativeDevice: true,
  nativeSetting: async (key: string) => storage.get(key),
  setNativeSetting: async (key: string, value: unknown) => {
    if (value === undefined) storage.delete(key);
    else storage.set(key, value);
  },
  restoreNativeDatabase: vi.fn(),
  collectNativeGarbage: vi.fn(async () => {}),
}));
vi.mock('./connectivity', () => ({ networkOnline: () => true, initializeConnectivity: vi.fn() }));
const path = '/api/v1/orgs/org/media/audio';
beforeEach(async () => {
  vi.stubEnv('VITE_API_URL', 'https://inspect.example.org');
  class ResourceURL extends URL {}
  ResourceURL.createObjectURL = vi.fn(() => 'blob:evidence');
  ResourceURL.revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', ResourceURL);
  vi.stubGlobal('fetch', vi.fn());
  await rememberSession(undefined);
  storage.clear();
  vi.mocked(collectNativeGarbage).mockClear();
  storage.set(`resource:${path}`, { bytes: new Uint8Array([1, 2]).buffer, mime: 'audio/wav' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it.each([401, 403, 404, 410])('does not serve cached evidence after HTTP %s', async (status) => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status }));
  await expect(loadProtectedResource(path, true)).rejects.toThrow('niet toegankelijk');
  expect(storage.has(`resource:${path}`)).toBe(false);
  expect(protectedURL(path)).toBe('');
  expect(collectNativeGarbage).toHaveBeenCalledOnce();
});
it('keeps cached evidence available during a temporary server outage', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
  expect(await loadProtectedResource(path)).toBe('blob:evidence');
  expect(storage.has(`resource:${path}`)).toBe(true);
});
it('removes retired evidence when refreshed dossier metadata arrives', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
  await loadProtectedResource(path);
  await prepareResponseResources(
    { media: [{ id: 'audio', contentDeletedAt: '2026-11-01T10:00:00Z' }] },
    '/orgs/org/inspections/visit',
  );
  expect(protectedURL(path)).toBe('');
  expect(storage.has(`resource:${path}`)).toBe(false);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:evidence');
  expect(collectNativeGarbage).toHaveBeenCalledOnce();
});
