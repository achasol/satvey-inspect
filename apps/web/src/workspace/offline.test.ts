import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { offlineAccount } from './offline';

const storage = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./nativeStorage', () => ({
  nativeDevice: true,
  nativeSetting: async (key: string) => storage.get(key),
  setNativeSetting: async (key: string, value: unknown) => {
    storage.set(key, value);
  },
}));
vi.mock('./outbox', () => ({}));
vi.mock('./platform', () => ({}));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T10:00:00Z'));
  storage.clear();
  storage.set('session', { userId: 'inspector', expiresAt: '2026-11-01T10:00:00Z' });
  storage.set('account', {
    user: { id: 'inspector' },
    organisations: [{ id: 'allowed' }, { id: 'expired' }],
  });
  storage.set('grant:inspector:allowed', {
    userId: 'inspector',
    orgId: 'allowed',
    expiresAt: '2026-10-31T11:00:00Z',
  });
  storage.set('grant:inspector:expired', {
    userId: 'inspector',
    orgId: 'expired',
    expiresAt: '2026-10-31T09:00:00Z',
  });
});
afterEach(() => vi.useRealTimers());
it('opens only organisations within the authenticated user offline window', async () => {
  const account = await offlineAccount();
  expect(account?.organisations.map((o) => o.id)).toEqual(['allowed']);
  expect(storage.get('last-clock')).toBe(Date.now());
});
it('never opens a previous account cache under another native session', async () => {
  storage.set('session', { userId: 'someone-else', expiresAt: '2026-11-01T10:00:00Z' });
  expect(await offlineAccount()).toBeUndefined();
});
it('locks expired grants without removing the cached work', async () => {
  vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
  await expect(offlineAccount()).rejects.toThrow('Offline toegang verlopen');
  expect(storage.has('account')).toBe(true);
});
it('rejects a backwards device clock and expired login', async () => {
  storage.set('last-clock', Date.now() + 120000);
  await expect(offlineAccount()).rejects.toThrow('apparaatklok');
  storage.set('session', { userId: 'inspector', expiresAt: '2026-10-30T10:00:00Z' });
  expect(await offlineAccount()).toBeUndefined();
});
