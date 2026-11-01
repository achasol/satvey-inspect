import { networkOnline } from './connectivity';
import { useEffect, useState } from 'react';
import { api, ApiError, json, uuid } from './api';
import { persistNativeDatabase, clearNativeDeviceStorage } from './nativeStorage';

export type LocalMedia = {
  captureSessionId?: string;
  audioSegmentId?: string;
  recordedAt?: string;
  id: string;
  name: string;
  mime: string;
  bytes: ArrayBuffer;
  duration: number;
};
export type Action = {
  id: string;
  scope: string;
  inspectionId: string;
  kind: 'capture' | 'edit';
  path: string;
  payload: Record<string, unknown>;
  files?: LocalMedia[];
  uploaded?: string[];
  createdAt: number;
  state: 'pending' | 'uploading' | 'failed' | 'conflict';
  error?: string;
  attempts?: number;
  retryAt?: number;
};
let connection: Promise<IDBDatabase> | undefined;
function database() {
  return (connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('satvey-workspace', 2);
    req.onupgradeneeded = () => {
      for (const name of ['outbox', 'cache', 'drafts', 'leases'])
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    };
    req.onerror = () => {
      connection = undefined;
      reject(req.error);
    };
    req.onblocked = () => {
      connection = undefined;
      reject(new Error('Sluit andere Satvey-tabbladen en probeer opnieuw.'));
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => {
        req.result.close();
        connection = undefined;
      };
      resolve(req.result);
    };
  }));
}
async function dbCall<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode),
      request = fn(tx.objectStore(store));
    tx.oncomplete = () => {
      void (mode === 'readwrite' ? persistNativeDatabase(db) : Promise.resolve()).then(
        () => resolve(request.result as T),
        reject,
      );
    };
    tx.onerror = () => reject(tx.error || new Error('Opslag op apparaat mislukt'));
    tx.onabort = () => reject(tx.error || new Error('Opslag op apparaat afgebroken'));
  });
}
function notify() {
  window.dispatchEvent(new Event('satvey-outbox'));
}
export async function saveAction(action: Action) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['outbox', 'cache'], 'readwrite');
    const deleted = tx
      .objectStore('cache')
      .get(`${action.scope}:deletedInspection:${action.inspectionId}`);
    deleted.onsuccess = () => {
      if (!deleted.result) tx.objectStore('outbox').put(action, action.id);
    };
    tx.oncomplete = () => {
      void persistNativeDatabase(db).then(() => resolve(), reject);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Opslaan mislukt'));
  });
  notify();
}
export async function removeAction(id: string) {
  await dbCall('outbox', 'readwrite', (s) => s.delete(id));
  notify();
}
// A camera visit is transferred exactly once, even if a tab closes during saving.
export async function commitCaptureDraft(key: string, action: Action) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['outbox', 'drafts'], 'readwrite');
    tx.objectStore('outbox').put(action, action.id);
    tx.objectStore('drafts').delete(key);
    tx.oncomplete = () => {
      void persistNativeDatabase(db).then(() => resolve(), reject);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Opslaan mislukt'));
  });
  notify();
  window.dispatchEvent(new Event('satvey-drafts'));
}
export async function actions(scope: string) {
  return (await dbCall<Action[]>('outbox', 'readonly', (s) => s.getAll()))
    .filter((a) => a.scope === scope)
    .sort((a, b) => a.createdAt - b.createdAt);
}
export const cacheKeys = async (prefix: string) =>
  (await dbCall<IDBValidKey[]>('cache', 'readonly', (store) => store.getAllKeys())).filter(
    (key): key is string => typeof key === 'string' && key.startsWith(prefix),
  );
export const cacheRemove = (key: string) =>
  dbCall('cache', 'readwrite', (store) => store.delete(key));
export const cacheGet = <T>(key: string) =>
  dbCall<T | undefined>('cache', 'readonly', (s) => s.get(key));
export const cachePut = (key: string, value: unknown) =>
  dbCall('cache', 'readwrite', (s) => s.put(value, key));

export async function forgetInspection(
  scope: string,
  path: string,
  inspectionId: string,
  observationIds: string[],
) {
  const cached = await cacheGet<{ observations?: { id: string }[] }>(`${scope}:${path}`);
  const observationKeys = new Set(
    [...observationIds, ...(cached?.observations || []).map((o) => o.id)].map(
      (id) => `${scope}:observation:${id}`,
    ),
  );
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['outbox', 'drafts', 'cache'], 'readwrite');
    tx.objectStore('cache').put(true, `${scope}:deletedInspection:${inspectionId}`);
    for (const name of ['outbox', 'drafts', 'cache']) {
      const request = tx.objectStore(name).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const key = String(cursor.key);
        if (
          (name === 'outbox' &&
            cursor.value.scope === scope &&
            cursor.value.inspectionId === inspectionId) ||
          (name === 'drafts' &&
            (key.startsWith(`${scope}:capture:${inspectionId}:`) ||
              key === `${scope}:handover:${inspectionId}` ||
              key.startsWith(`${scope}:inspectionDraft:${inspectionId}:`) ||
              observationKeys.has(key))) ||
          (name === 'cache' && (key === `${scope}:${path}` || key.startsWith(`${scope}:${path}/`)))
        ) {
          cursor.delete();
        } else if (
          name === 'cache' &&
          (key === `${scope}:${path.slice(0, path.lastIndexOf('/'))}` ||
            key.startsWith(`${scope}:${path.slice(0, path.lastIndexOf('/'))}?`))
        ) {
          cursor.update((cursor.value as { id: string }[]).filter((i) => i.id !== inspectionId));
        }
        cursor.continue();
      };
    }
    tx.oncomplete = () => {
      void persistNativeDatabase(db).then(() => resolve(), reject);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error || new Error('Lokale inspectiegegevens verwijderen mislukt'));
  });
  notify();
  window.dispatchEvent(new Event('satvey-drafts'));
}
export const draftGet = <T = { roomId: string; files: LocalMedia[] }>(key: string) =>
  dbCall<T | undefined>('drafts', 'readonly', (s) => s.get(key));
export async function draftPut(key: string, value: unknown) {
  await dbCall('drafts', 'readwrite', (s) => s.put(value, key));
  window.dispatchEvent(new Event('satvey-drafts'));
}
export async function draftRemove(key: string) {
  await dbCall('drafts', 'readwrite', (s) => s.delete(key));
  window.dispatchEvent(new Event('satvey-drafts'));
}
export async function pendingDraftCount(
  scope: string,
  inspectionId: string,
  observationIds: string[],
) {
  const keys = await dbCall<IDBValidKey[]>('drafts', 'readonly', (s) => s.getAllKeys());
  const matches = keys.filter(
    (k) =>
      typeof k === 'string' &&
      (k.startsWith(`${scope}:capture:${inspectionId}:`) ||
        k.startsWith(`${scope}:inspectionDraft:${inspectionId}:`) ||
        observationIds.some((id) => k === `${scope}:observation:${id}`)),
  );
  const values = await Promise.all(
    matches.map((key) =>
      dbCall<{ files?: unknown[]; id?: string; draft?: boolean }>('drafts', 'readonly', (s) =>
        s.get(key),
      ),
    ),
  );
  return values.filter((value) => value && (value.id || value.draft || value.files?.length)).length;
}
const leaseOwner = uuid();
const leaseDuration = 45_000;
let activeScope = '',
  syncing = false,
  resyncScope = '';
let syncController: AbortController | undefined;

// A read/write transaction serializes acquisition across tabs, including Safari.
async function lease(scope: string, release = false): Promise<boolean> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('leases', 'readwrite');
    const store = tx.objectStore('leases');
    const request = store.get(scope);
    let owned = false;
    request.onsuccess = () => {
      const current = request.result as { owner: string; until: number } | undefined;
      if (release) {
        if (current?.owner === leaseOwner) store.delete(scope);
      } else if (!current || current.owner === leaseOwner || current.until <= Date.now()) {
        store.put({ owner: leaseOwner, until: Date.now() + leaseDuration }, scope);
        owned = true;
      }
    };
    tx.oncomplete = () => resolve(owned);
    tx.onerror = tx.onabort = () =>
      reject(tx.error || new Error('Synchronisatievergrendeling mislukt'));
  });
}
export function setScope(scope: string) {
  if (activeScope !== scope) syncController?.abort();
  activeScope = scope;
}
export async function sync(scope: string, retryNow = false) {
  if (activeScope !== scope || !networkOnline()) return;
  if (syncing) {
    resyncScope = scope;
    return;
  }
  syncing = true;
  const controller = new AbortController();
  syncController = controller;
  let renewal: number | undefined;
  let acquired = false;
  try {
    acquired = await lease(scope);
    if (!acquired || activeScope !== scope) return;
    renewal = window.setInterval(() => {
      void lease(scope)
        .then((owned) => {
          if (!owned) controller.abort();
        })
        .catch(() => controller.abort());
    }, 10_000);
    const valid = () => activeScope === scope && !controller.signal.aborted && networkOnline();
    for (const action of await actions(scope)) {
      if (!valid()) break;
      if (
        action.state === 'conflict' ||
        (!retryNow && action.state === 'failed' && (action.retryAt || 0) > Date.now())
      )
        continue;
      action.state = 'uploading';
      action.error = undefined;
      await saveAction(action);
      try {
        if (!valid()) throw new DOMException('Synchronisatie gepauzeerd', 'AbortError');
        if (action.kind === 'capture') {
          await api(action.path, {
            ...json('POST', action.payload),
            headers: { 'X-Satvey-User': scope.split(':')[0] },
            signal: controller.signal,
          });
          for (const file of action.files || []) {
            if (!valid()) throw new DOMException('Synchronisatie gepauzeerd', 'AbortError');
            if (action.uploaded?.includes(file.id)) continue;
            await api(`${action.path}/${action.id}/media/${file.id}`, {
              method: 'PUT',
              signal: controller.signal,
              headers: {
                'X-Satvey-User': scope.split(':')[0],
                'Content-Type': file.mime,
                'X-File-Name': encodeURIComponent(file.name),
                'X-Audio-Duration': String(file.duration),
                ...(file.captureSessionId ? { 'X-Capture-Session': file.captureSessionId } : {}),
                ...(file.audioSegmentId ? { 'X-Audio-Segment': file.audioSegmentId } : {}),
                ...(file.recordedAt ? { 'X-Recorded-At': file.recordedAt } : {}),
              },
              body: new Blob([file.bytes], { type: file.mime }),
            });
            action.uploaded = [...(action.uploaded || []), file.id];
            await saveAction(action);
          }
        } else
          await api(action.path, {
            ...json('PUT', action.payload),
            headers: { 'X-Satvey-User': scope.split(':')[0] },
            signal: controller.signal,
          });
        await removeAction(action.id);
        window.dispatchEvent(new Event('satvey-refresh'));
      } catch (error) {
        if (!valid() || (error instanceof ApiError && error.status === 401)) {
          action.state = 'pending';
          action.error = undefined;
          await saveAction(action);
          break;
        }
        action.state =
          error instanceof ApiError && [400, 403, 404, 409, 413, 415, 422].includes(error.status)
            ? 'conflict'
            : 'failed';
        action.error = error instanceof Error ? error.message : 'Upload mislukt';
        action.attempts = (action.attempts || 0) + 1;
        action.retryAt = Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(action.attempts, 6));
        await saveAction(action);
        if (!(error instanceof ApiError) || error.status === 429 || error.status >= 500) break;
      }
    }
  } finally {
    clearInterval(renewal);
    if (acquired) await lease(scope, true).catch(() => {});
    syncing = false;
    if (syncController === controller) syncController = undefined;
    const next = resyncScope;
    resyncScope = '';
    if (next && next !== scope) await sync(next);
  }
}
export function useOutbox(scope: string) {
  const [items, setItems] = useState<Action[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void actions(scope)
        .then((value) => {
          if (alive) setItems(value);
        })
        .catch((e) => {
          if (alive) setError(String(e));
        });
    };
    const upload = (retryNow = false) => {
      void sync(scope, retryNow).catch((e) => {
        if (alive) setError(String(e));
      });
    };
    const reconnect = () => upload(true);
    setScope(scope);
    refresh();
    upload();
    window.addEventListener('satvey-outbox', refresh);
    window.addEventListener('online', reconnect);
    const timer = window.setInterval(upload, 10000);
    return () => {
      alive = false;
      if (activeScope === scope) setScope('');
      clearInterval(timer);
      window.removeEventListener('satvey-outbox', refresh);
      window.removeEventListener('online', reconnect);
    };
  }, [scope]);
  return { items, error };
}
export async function enqueueEdit(
  scope: string,
  inspectionId: string,
  path: string,
  payload: Record<string, unknown>,
) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['outbox', 'cache'], 'readwrite');
    const store = tx.objectStore('outbox');
    let failure: Error | undefined;
    const deleted = tx.objectStore('cache').get(`${scope}:deletedInspection:${inspectionId}`);
    deleted.onsuccess = () => {
      if (deleted.result) {
        failure = new Error('Deze inspectie is verwijderd.');
        tx.abort();
        return;
      }
      const request = store.getAll();
      request.onsuccess = () => {
        if (
          (request.result as Action[]).some(
            (a) => a.scope === scope && a.path === path && a.kind === 'edit',
          )
        ) {
          failure = new Error(
            'Deze wijziging wacht nog op synchronisatie. Synchroniseer eerst of los het conflict op.',
          );
          tx.abort();
          return;
        }
        const action: Action = {
          id: uuid(),
          scope,
          inspectionId,
          path,
          payload,
          kind: 'edit',
          state: 'pending',
          createdAt: Date.now(),
        };
        store.put(action, action.id);
      };
    };
    tx.oncomplete = () => {
      void persistNativeDatabase(db).then(() => resolve(), reject);
    };
    tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('Opslaan mislukt'));
  });
  notify();
  void sync(scope).catch(() => notify());
}

export async function deviceHasPendingWork() {
  if ((await dbCall<Action[]>('outbox', 'readonly', (store) => store.getAll())).length) return true;
  const drafts = await dbCall<{ id?: string; draft?: boolean; files?: unknown[] }[]>(
    'drafts',
    'readonly',
    (store) => store.getAll(),
  );
  return drafts.some((value) => value && (value.id || value.draft || value.files?.length));
}
export async function clearDeviceStorage() {
  if (await deviceHasPendingWork()) throw new Error('Synchroniseer eerst het lokale werk.');
  const db = await database();
  db.close();
  connection = undefined;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('satvey-workspace');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('Sluit andere Satvey-tabbladen en verwijder daarna de lokale gegevens.'));
  });
  await clearNativeDeviceStorage();
}

export async function scopeDraftCount(scope: string) {
  const db = await database();
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction('drafts', 'readonly');
    const request = tx.objectStore('drafts').openCursor();
    let count = 0;
    request.onsuccess = () => {
      const c = request.result;
      if (!c) return;
      const v = c.value as { id?: string; draft?: boolean; files?: unknown[] };
      if (String(c.key).startsWith(`${scope}:`) && v && (v.id || v.draft || v.files?.length))
        count++;
      c.continue();
    };
    tx.oncomplete = () => resolve(count);
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeInspectionCache(scope: string, path: string) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('cache', 'readwrite');
    const request = tx.objectStore('cache').openCursor();
    request.onsuccess = () => {
      const c = request.result;
      if (!c) return;
      const key = String(c.key);
      if (key === `${scope}:${path}` || key.startsWith(`${scope}:${path}/`)) c.delete();
      c.continue();
    };
    tx.oncomplete = () => {
      void persistNativeDatabase(db).then(resolve, reject);
    };
    tx.onerror = () => reject(tx.error);
  });
}
