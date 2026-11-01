import { Capacitor } from '@capacitor/core';
import type { MediaResult } from '@capacitor/camera';
import type { LocalMedia } from './outbox';
import { nativeSetting, setNativeSetting } from './nativeStorage';

type CaptureContext = {
  scope: string;
  inspectionId: string;
  roomId: string;
  draftKey: string;
  ids: string[];
};
async function normalize(media: MediaResult, id: string): Promise<LocalMedia> {
  const source = media.webPath || (media.uri ? Capacitor.convertFileSrc(media.uri) : '');
  if (!source) throw new Error('De camera gaf geen leesbaar bestand terug.');
  const image = new Image();
  image.src = source;
  await image.decode();
  const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Foto kon niet worden omgezet.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('Foto kon niet worden omgezet.'))),
      'image/jpeg',
      0.92,
    ),
  );
  if (blob.size > 20 * 1048576) throw new Error('Deze foto is groter dan 20 MiB.');
  return {
    id,
    name: `Foto-${id}.jpg`,
    mime: 'image/jpeg',
    duration: 0,
    bytes: await blob.arrayBuffer(),
  };
}
export async function nativePhotos(context: Omit<CaptureContext, 'ids'>, camera: boolean) {
  if (await nativeSetting('pending-camera-result'))
    throw new Error(
      'Een eerdere cameraopname wacht op herstel. Bewaar eerst je lokale werk en open de app opnieuw om deze opname te herstellen.',
    );
  const { Camera, EncodingType, MediaTypeSelection } = await import('@capacitor/camera');
  const pending = { ...context, ids: Array.from({ length: 30 }, () => crypto.randomUUID()) };
  await setNativeSetting('pending-camera', pending);
  try {
    const results = camera
      ? [
          await Camera.takePhoto({
            quality: 92,
            encodingType: EncodingType.JPEG,
            correctOrientation: true,
            saveToGallery: false,
          }),
        ]
      : (
          await Camera.chooseFromGallery({
            mediaType: MediaTypeSelection.Photo,
            allowMultipleSelection: true,
            limit: 30,
            quality: 92,
            correctOrientation: true,
          })
        ).results;
    await setNativeSetting('pending-camera-result', { results });
    return await Promise.all(results.map((result, index) => normalize(result, pending.ids[index])));
  } catch (error) {
    if (!(await nativeSetting('pending-camera-result')))
      await setNativeSetting('pending-camera', undefined);
    throw error;
  }
}
export async function finishNativeCapture() {
  await setNativeSetting('pending-camera-result', undefined);
  await setNativeSetting('pending-camera', undefined);
}
export async function restoreNativeCapture(data: unknown) {
  const context = await nativeSetting<CaptureContext>('pending-camera');
  if (!context) return;
  await setNativeSetting('pending-camera-result', data);
  const result = data as MediaResult & { results?: MediaResult[] };
  const results = result.results || [result];
  const photos = await Promise.all(
    results.map((item, index) => normalize(item, context.ids[index])),
  );
  const { draftGet, draftPut } = await import('./outbox');
  const existing = await draftGet<{
    draft?: boolean;
    id?: string;
    roomId: string;
    files: LocalMedia[];
  }>(context.draftKey);
  const files = new Map((existing?.files || []).map((f) => [f.id, f]));
  for (const photo of photos) files.set(photo.id, photo);
  await draftPut(context.draftKey, {
    ...existing,
    draft: true,
    id: existing?.id || crypto.randomUUID(),
    roomId: context.roomId,
    files: [...files.values()],
  });
  await finishNativeCapture();
  window.dispatchEvent(new CustomEvent('satvey-camera-restored', { detail: context.draftKey }));
}
