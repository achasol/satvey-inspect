import { useEffect, useState } from 'react';
import { api, ApiError, json, uuid } from './api';

export type LocalMedia = {
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
};
let connection: Promise<IDBDatabase> | undefined;
function database() {
  return (connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('satvey-workspace', 1);
    req.onupgradeneeded = () => {
      for (const name of ['outbox', 'cache', 'drafts']) req.result.createObjectStore(name);
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
    tx.oncomplete = () => resolve(request.result as T);
    tx.onerror = () => reject(tx.error || new Error('Opslag op apparaat mislukt'));
    tx.onabort = () => reject(tx.error || new Error('Opslag op apparaat afgebroken'));
  });
}
function notify() {
  window.dispatchEvent(new Event('satvey-outbox'));
}
export async function saveAction(action: Action) {
  await dbCall('outbox', 'readwrite', (s) => s.put(action, action.id));
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
    tx.oncomplete = () => resolve();
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
export const cacheGet = <T>(key: string) =>
  dbCall<T | undefined>('cache', 'readonly', (s) => s.get(key));
export const cachePut = (key: string, value: unknown) =>
  dbCall('cache', 'readwrite', (s) => s.put(value, key));
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
let activeScope = '',
  syncing = false;
export function setScope(scope: string) {
  activeScope = scope;
}
export async function sync(scope: string) {
  if (syncing || activeScope !== scope || !navigator.onLine) return;
  syncing = true;
  try {
    for (const action of await actions(scope)) {
      if (activeScope !== scope || !navigator.onLine) break;
      if (action.state === 'conflict') continue;
      action.state = 'uploading';
      action.error = undefined;
      await saveAction(action);
      try {
        if (action.kind === 'capture') {
          await api(action.path, json('POST', action.payload));
          for (const file of action.files || []) {
            if (activeScope !== scope) {
              action.state = 'pending';
              await saveAction(action);
              return;
            }
            if (action.uploaded?.includes(file.id)) continue;
            await api(`${action.path}/${action.id}/media/${file.id}`, {
              method: 'PUT',
              headers: {
                'Content-Type': file.mime,
                'X-File-Name': encodeURIComponent(file.name),
                'X-Audio-Duration': String(file.duration),
              },
              body: new Blob([file.bytes], { type: file.mime }),
            });
            action.uploaded = [...(action.uploaded || []), file.id];
            await saveAction(action);
          }
        } else await api(action.path, json('PUT', action.payload));
        await removeAction(action.id);
        window.dispatchEvent(new Event('satvey-refresh'));
      } catch (error) {
        action.state =
          error instanceof ApiError && [403, 404, 409, 422].includes(error.status)
            ? 'conflict'
            : 'failed';
        action.error = error instanceof Error ? error.message : 'Upload mislukt';
        await saveAction(action);
        if (!(error instanceof ApiError) || error.status === 401 || error.status >= 500) break;
      }
    }
  } finally {
    syncing = false;
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
    const upload = () => {
      void sync(scope).catch((e) => {
        if (alive) setError(String(e));
      });
    };
    setScope(scope);
    refresh();
    upload();
    window.addEventListener('satvey-outbox', refresh);
    window.addEventListener('online', upload);
    const timer = window.setInterval(upload, 10000);
    return () => {
      alive = false;
      if (activeScope === scope) setScope('');
      clearInterval(timer);
      window.removeEventListener('satvey-outbox', refresh);
      window.removeEventListener('online', upload);
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
  const existing = (await actions(scope)).find((a) => a.path === path && a.kind === 'edit');
  if (existing)
    throw new Error(
      'Deze wijziging wacht nog op synchronisatie. Synchroniseer eerst of los het conflict op.',
    );
  await saveAction({
    id: uuid(),
    scope,
    inspectionId,
    path,
    payload,
    kind: 'edit',
    state: 'pending',
    createdAt: Date.now(),
  });
  void sync(scope);
}
