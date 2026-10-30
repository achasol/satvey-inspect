import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from './outbox';

const fixture = (scope = 'user:org'): Action => ({
  id: crypto.randomUUID(),
  scope,
  inspectionId: 'inspection',
  kind: 'edit',
  path: '/orgs/org/inspections/inspection/observations/one',
  payload: { title: 'Lokale tekst', version: 1 },
  createdAt: Date.now(),
  state: 'pending',
});
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } })),
  );
});

describe('durable evidence queue', () => {
  it('atomically rejects concurrent edits of the same finding without losing the first text', async () => {
    const box = await import('./outbox');
    const results = await Promise.allSettled([
      box.enqueueEdit('s', 'i', '/finding', { text: 'first' }),
      box.enqueueEdit('s', 'i', '/finding', { text: 'second' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await box.actions('s')).map((a) => a.payload)).toEqual([{ text: 'first' }]);
  });
  it('preserves drafts and queues across module reload without crossing account boundaries', async () => {
    const box = await import('./outbox');
    const action = fixture();
    await box.saveAction(action);
    await box.draftPut('user:org:observation:one', { draft: true, text: 'unsaved' });
    vi.resetModules();
    const reopened = await import('./outbox');
    expect(await reopened.actions('another:org')).toEqual([]);
    expect(await reopened.actions('user:org')).toEqual([action]);
    expect(await reopened.draftGet('user:org:observation:one')).toEqual({
      draft: true,
      text: 'unsaved',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('sends a queued edit once when two tabs synchronize concurrently', async () => {
    const a = await import('./outbox');
    a.setScope('user:org');
    await a.saveAction(fixture());
    vi.resetModules();
    const b = await import('./outbox');
    b.setScope('user:org');
    await Promise.all([a.sync('user:org'), b.sync('user:org')]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await a.actions('user:org')).toEqual([]);
  });
  it('retains local text on a version conflict and does not automatically retry it', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('{"error":"conflict"}', {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const box = await import('./outbox');
    box.setScope('user:org');
    const action = fixture();
    await box.saveAction(action);
    await box.sync('user:org');
    await box.sync('user:org');
    await box.sync('user:org', true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await box.actions('user:org'))[0]).toMatchObject({
      state: 'conflict',
      payload: action.payload,
    });
  });
  it('backs off after server failures while keeping evidence durable', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('{"error":"unavailable"}', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const box = await import('./outbox');
    box.setScope('user:org');
    await box.saveAction(fixture());
    await box.sync('user:org');
    await box.sync('user:org');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await box.actions('user:org'))[0].state).toBe('failed');
    vi.mocked(fetch).mockResolvedValue(
      new Response('{}', { headers: { 'content-type': 'application/json' } }),
    );
    await box.sync('user:org', true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await box.actions('user:org')).toEqual([]);
  });
  it('recovers an abandoned tab lease after expiry without stealing a live lease', async () => {
    const box = await import('./outbox');
    box.setScope('user:org');
    await box.saveAction(fixture());
    const now = Date.now();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('satvey-workspace');
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('leases', 'readwrite');
        tx.objectStore('leases').put({ owner: 'closed-tab', until: now + 45_000 }, 'user:org');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    await box.sync('user:org', true);
    expect(fetch).not.toHaveBeenCalled();
    vi.spyOn(Date, 'now').mockReturnValue(now + 45_001);
    await box.sync('user:org', true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await box.actions('user:org')).toEqual([]);
  });
  it('stops an in-flight upload when the account is signed out', async () => {
    const box = await import('./outbox');
    box.setScope('user:org');
    await box.saveAction(fixture());
    vi.mocked(fetch).mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        ),
    );
    const pending = box.sync('user:org');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    box.setScope('');
    await pending;
    expect((await box.actions('user:org'))[0].state).toBe('pending');
  });
  it('never recreates queued changes for a deleted inspection', async () => {
    const box = await import('./outbox');
    const action = fixture();
    await box.saveAction(action);
    await box.forgetInspection('user:org', '/orgs/org/inspections/inspection', 'inspection', [
      'one',
    ]);
    await box.saveAction(action);
    expect(await box.actions('user:org')).toEqual([]);
    await expect(box.enqueueEdit('user:org', 'inspection', action.path, {})).rejects.toThrow(
      'verwijderd',
    );
  });
  it('rejects device-storage failures instead of reporting a successful save', async () => {
    const box = await import('./outbox');
    await expect(box.draftPut('draft', () => 'uncloneable')).rejects.toBeDefined();
  });
  it('upgrades a version-one database without removing existing drafts', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('satvey-workspace', 1);
      req.onupgradeneeded = () => {
        for (const name of ['outbox', 'cache', 'drafts']) req.result.createObjectStore(name);
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('drafts', 'readwrite');
        tx.objectStore('drafts').put({ text: 'preserved' }, 'draft');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
      req.onerror = () => reject(req.error);
    });
    const box = await import('./outbox');
    expect(await box.draftGet('draft')).toEqual({ text: 'preserved' });
  });
});
