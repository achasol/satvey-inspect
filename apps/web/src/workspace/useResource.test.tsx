import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';
import { cacheGet, cachePut } from './outbox';
import { useResource } from './useResource';

vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  api: vi.fn(),
}));
vi.mock('./outbox', () => ({ cacheGet: vi.fn(), cachePut: vi.fn() }));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(cacheGet).mockReset();
  vi.mocked(cachePut).mockResolvedValue(undefined);
});

describe('scoped resource recovery', () => {
  it('ignores an old response even when the transport ignores cancellation', async () => {
    const old = deferred<string>();
    vi.mocked(api).mockReturnValueOnce(old.promise).mockResolvedValueOnce('new');
    const hook = renderHook(() => useResource<string>('user:org', '/inspections'));
    act(() => window.dispatchEvent(new Event('satvey-refresh')));
    await waitFor(() => expect(hook.result.current.data).toBe('new'));
    await act(async () => old.resolve('old'));
    expect(hook.result.current.data).toBe('new');
    expect(cachePut).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it('does not show or cache an old organisation response after switching scope', async () => {
    const old = deferred<string>();
    vi.mocked(api).mockReturnValueOnce(old.promise).mockResolvedValueOnce('org-b');
    const hook = renderHook(({ scope }) => useResource<string>(scope, '/items'), {
      initialProps: { scope: 'user:org-a' },
    });
    hook.rerender({ scope: 'user:org-b' });
    await waitFor(() => expect(hook.result.current.data).toBe('org-b'));
    await act(async () => old.resolve('org-a'));
    expect(hook.result.current.data).toBe('org-b');
    expect(cachePut).toHaveBeenCalledWith('user:org-b:/items', 'org-b');
  });
  it('uses only the scoped cache for a network failure', async () => {
    vi.mocked(api).mockRejectedValue(new TypeError('offline'));
    vi.mocked(cacheGet).mockResolvedValue([]);
    const hook = renderHook(() => useResource<unknown[]>('user:org', '/items'));
    await waitFor(() => expect(hook.result.current.cached).toBe(true));
    expect(cacheGet).toHaveBeenCalledWith('user:org:/items');
    expect(hook.result.current.data).toEqual([]);
  });
  it.each([401, 403, 404])(
    'never falls back to cached confidential data after HTTP %s',
    async (status) => {
      vi.mocked(api).mockRejectedValue(new ApiError(status, 'denied'));
      const hook = renderHook(() => useResource('user:org', '/items'));
      await waitFor(() => expect(hook.result.current.error).toBe('denied'));
      expect(hook.result.current.data).toBeUndefined();
      expect(cacheGet).not.toHaveBeenCalled();
    },
  );
  it('aborts and ignores responses after unmount', async () => {
    const response = deferred<string>();
    vi.mocked(api).mockReturnValue(response.promise);
    const hook = renderHook(() => useResource('user:org', '/items'));
    hook.unmount();
    await act(async () => response.resolve('late'));
    expect(cachePut).not.toHaveBeenCalled();
    expect(vi.mocked(api).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
