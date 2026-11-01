import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  clearNativeDeviceStorage,
  collectNativeGarbage,
  nativeSetting,
  setNativeSetting,
} from './nativeStorage';

const local = vi.hoisted(() => ({
  files: new Map<string, string>(),
  settings: new Map<string, string>(),
  shortWrite: false,
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {
    async isSecretStored() {
      return { result: true };
    }
    async createConnection() {
      return {
        open: async () => {},
        execute: async (sql: string) => {
          if (sql.startsWith('DELETE')) local.settings.clear();
        },
        query: async (_sql: string, args?: string[]) => ({
          values: args
            ? local.settings.has(args[0])
              ? [{ value: local.settings.get(args[0]) }]
              : []
            : [...local.settings.values()].map((value) => ({ value })),
        }),
        run: async (sql: string, args: string[]) => {
          if (sql.startsWith('DELETE')) local.settings.delete(args[0]);
          else local.settings.set(args[0], args[1]);
        },
      };
    }
  },
}));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'data', Cache: 'cache' },
  Filesystem: {
    readFile: async ({ path }: { path: string }) => {
      if (!local.files.has(path)) throw new Error('File missing');
      return { data: local.files.get(path) };
    },
    writeFile: async ({ path, data }: { path: string; data: string }) => {
      local.files.set(path, local.shortWrite ? btoa('partial') : data);
      return { uri: path };
    },
    readdir: async () => ({
      files: [...local.files.keys()].map((path) => ({ name: path.split('/').pop() })),
    }),
    deleteFile: async ({ path }: { path: string }) => {
      local.files.delete(path);
    },
    rmdir: async () => {
      local.files.clear();
    },
  },
}));
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  local.shortWrite = false;
  await clearNativeDeviceStorage();
});
afterEach(() => vi.unstubAllGlobals());
it('rejects a truncated native write before acknowledging the save', async () => {
  local.shortWrite = true;
  await expect(setNativeSetting('capture', new Uint8Array([1, 2, 3, 4]).buffer)).rejects.toThrow(
    'beschadigd',
  );
  expect(local.settings.has('capture')).toBe(false);
});
it('repairs a partial file when the inspector retries from the original bytes', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
  local.shortWrite = true;
  await expect(setNativeSetting('capture', bytes)).rejects.toThrow();
  local.shortWrite = false;
  await setNativeSetting('capture', bytes);
  expect(new Uint8Array((await nativeSetting<ArrayBuffer>('capture'))!)).toEqual(
    new Uint8Array(bytes),
  );
});
it('can save identical evidence again after its unreferenced file was collected', async () => {
  const bytes = new Uint8Array([5, 6, 7, 8]).buffer;
  await setNativeSetting('capture', bytes);
  await setNativeSetting('capture', undefined);
  await collectNativeGarbage();
  expect(local.files.size).toBe(0);
  await setNativeSetting('capture', bytes);
  expect(new Uint8Array((await nativeSetting<ArrayBuffer>('capture'))!)).toEqual(
    new Uint8Array(bytes),
  );
});
