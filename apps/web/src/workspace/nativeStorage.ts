import { Capacitor } from '@capacitor/core';
import type { SQLiteDBConnection } from '@capacitor-community/sqlite';

export const nativeDevice = Capacitor.isNativePlatform();
const verifiedFiles = new Set<string>();
let connection: Promise<SQLiteDBConnection> | undefined;
let persistence: Promise<unknown> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const next = persistence.catch(() => {}).then(operation);
  persistence = next;
  return next;
}
async function database() {
  return (connection ??= (async () => {
    const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite');
    const sqlite = new SQLiteConnection(CapacitorSQLite);
    if (!(await sqlite.isSecretStored()).result) {
      const secret = [...crypto.getRandomValues(new Uint8Array(32))]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('');
      await sqlite.setEncryptionSecret(secret);
    }
    const db = await sqlite.createConnection('satvey', true, 'secret', 1, false);
    await db.open();
    await db.execute(
      'CREATE TABLE IF NOT EXISTS records (store TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(store,key)); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);',
    );
    return db;
  })());
}
export async function nativeSetting<T>(key: string): Promise<T | undefined> {
  if (!nativeDevice) return;
  return serialized(async () => {
    const rows = (await (await database()).query('SELECT value FROM settings WHERE key=?', [key]))
      .values;
    return rows?.[0] ? ((await decode(JSON.parse(rows[0].value as string))) as T) : undefined;
  });
}
export async function setNativeSetting(key: string, value: unknown) {
  if (!nativeDevice) return;
  return serialized(async () => {
    const db = await database();
    if (value === undefined) await db.run('DELETE FROM settings WHERE key=?', [key]);
    else
      await db.run('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)', [
        key,
        JSON.stringify(await encode(value)),
      ]);
  });
}
function base64(bytes: Uint8Array) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
async function digest(data: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
async function encode(value: unknown): Promise<unknown> {
  if (value instanceof ArrayBuffer) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const key = await digest(value),
      path = `evidence/${key}`;
    const reference = { $satveyFile: path, sha256: key };
    if (!verifiedFiles.has(path)) {
      let valid = false;
      try {
        await decode(reference);
        valid = true;
      } catch {
        /* Retry from the original bytes after an incomplete write. */
      }
      if (!valid) {
        await Filesystem.writeFile({
          path,
          directory: Directory.Data,
          data: base64(new Uint8Array(value)),
          recursive: true,
        });
        // Confirm the stored bytes before committing a reference and acknowledging a save.
        await decode(reference);
      }
    }
    return reference;
  }
  if (Array.isArray(value)) return Promise.all(value.map(encode));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = await encode(item);
    return result;
  }
  return value;
}
async function decode(value: unknown): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(decode));
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (typeof object.$satveyFile === 'string' && typeof object.sha256 === 'string') {
      if (!/^evidence\/[0-9a-f]{64}$/.test(object.$satveyFile))
        throw new Error('Ongeldige lokale bronverwijzing');
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const read = await Filesystem.readFile({
        path: object.$satveyFile,
        directory: Directory.Data,
      });
      const bytes =
        typeof read.data === 'string'
          ? Uint8Array.from(atob(read.data), (c) => c.charCodeAt(0)).buffer
          : await read.data.arrayBuffer();
      if ((await digest(bytes)) !== object.sha256)
        throw new Error(
          'Lokaal bronbewijs is beschadigd; verwijder de app niet en neem contact op met ondersteuning.',
        );
      verifiedFiles.add(object.$satveyFile);
      return bytes;
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) result[key] = await decode(item);
    return result;
  }
  return value;
}

// IndexedDB is the UI projection. A save is acknowledged only after the native
// SQLite transaction commits; private evidence files are written before it.
export async function persistNativeDatabase(db: IDBDatabase) {
  if (!nativeDevice) return;
  try {
    await serialized(async () => {
      const stores = ['outbox', 'cache', 'drafts'];
      const snapshot = await new Promise<{ store: string; key: string; value: unknown }[]>(
        (resolve, reject) => {
          const tx = db.transaction(stores, 'readonly'),
            rows: { store: string; key: string; value: unknown }[] = [];
          for (const store of stores) {
            const request = tx.objectStore(store).openCursor();
            request.onsuccess = () => {
              const cursor = request.result;
              if (cursor) {
                rows.push({ store, key: JSON.stringify(cursor.key), value: cursor.value });
                cursor.continue();
              }
            };
          }
          tx.oncomplete = () => resolve(rows);
          tx.onerror = tx.onabort = () => reject(tx.error);
        },
      );
      const set = [{ statement: 'DELETE FROM records', values: [] as unknown[] }];
      for (const row of snapshot)
        set.push({
          statement: 'INSERT INTO records(store,key,value) VALUES(?,?,?)',
          values: [row.store, row.key, JSON.stringify(await encode(row.value))],
        });
      await (await database()).executeSet(set, true);
    });
    window.dispatchEvent(new CustomEvent('satvey-storage-health', { detail: '' }));
  } catch (error) {
    window.dispatchEvent(
      new CustomEvent('satvey-storage-health', {
        detail:
          'Opslaan op apparaat mislukt. Houd het scherm open en neem contact op met ondersteuning.',
      }),
    );
    throw error;
  }
}
export async function restoreNativeDatabase() {
  if (!nativeDevice) return;
  const rows = (await (await database()).query('SELECT store,key,value FROM records')).values || [];
  const prepared: { store: string; key: IDBValidKey; value: unknown }[] = [];
  for (const row of rows) {
    if (!['outbox', 'cache', 'drafts'].includes(row.store as string))
      throw new Error('Ongeldige lokale opslag');
    prepared.push({
      store: row.store as string,
      key: JSON.parse(row.key as string),
      value: await decode(JSON.parse(row.value as string)),
    });
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('satvey-workspace', 2);
    request.onupgradeneeded = () => {
      for (const store of ['outbox', 'cache', 'drafts', 'leases'])
        if (!request.result.objectStoreNames.contains(store))
          request.result.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['outbox', 'cache', 'drafts', 'leases'], 'readwrite');
      for (const store of ['outbox', 'cache', 'drafts', 'leases']) tx.objectStore(store).clear();
      for (const row of prepared) tx.objectStore(row.store).put(row.value, row.key);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function clearNativeDeviceStorage() {
  if (!nativeDevice) return;
  await serialized(async () => {
    const db = await database();
    await db.execute('DELETE FROM records; DELETE FROM settings;');
    verifiedFiles.clear();
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    for (const [directory, path] of [
      [Directory.Data, 'evidence'],
      [Directory.Cache, 'exports'],
    ] as const) {
      try {
        await Filesystem.rmdir({ directory, path, recursive: true });
      } catch {
        /* An empty device need not have these directories. */
      }
    }
  });
}

// Collect after database commits so pending work always
// retains its files, including records belonging to another signed-in account.
export async function collectNativeGarbage() {
  if (!nativeDevice) return;
  await serialized(async () => {
    const db = await database();
    const rows =
      (await db.query('SELECT value FROM records UNION ALL SELECT value FROM settings')).values ||
      [];
    const referenced = new Set<string>();
    for (const row of rows)
      for (const match of String(row.value).matchAll(/evidence\/[0-9a-f]{64}/g))
        referenced.add(match[0]);
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    let files;
    try {
      files = (await Filesystem.readdir({ directory: Directory.Data, path: 'evidence' })).files;
    } catch {
      return;
    }
    for (const file of files) {
      const path = `evidence/${file.name}`;
      if (/^[0-9a-f]{64}$/.test(file.name) && !referenced.has(path)) {
        await Filesystem.deleteFile({ directory: Directory.Data, path });
        verifiedFiles.delete(path);
      }
    }
  });
}
