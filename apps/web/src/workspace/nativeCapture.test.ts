import { expect, it, vi } from 'vitest';
import { nativePhotos } from './nativeCapture';

const original = vi.hoisted(() => ({
  scope: 'original-user:org',
  inspectionId: 'original-visit',
  roomId: 'original-room',
  draftKey: 'original-draft',
  ids: ['original-photo'],
}));
const storage = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./nativeStorage', () => ({
  nativeSetting: async (key: string) => storage.get(key),
  setNativeSetting: async (key: string, value: unknown) => {
    storage.set(key, value);
  },
}));
it('preserves pending camera evidence and its original room when another capture is requested', async () => {
  storage.set('pending-camera', original);
  storage.set('pending-camera-result', { uri: 'file:///pending-photo.jpg' });
  await expect(
    nativePhotos(
      {
        scope: 'other-user:org',
        inspectionId: 'new-visit',
        roomId: 'new-room',
        draftKey: 'new-draft',
      },
      true,
    ),
  ).rejects.toThrow('wacht op herstel');
  expect(storage.get('pending-camera')).toEqual(original);
  expect(storage.get('pending-camera-result')).toEqual({ uri: 'file:///pending-photo.jpg' });
});
