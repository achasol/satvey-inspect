import { uuid } from './api';
import {
  commitCaptureDraft,
  draftGet,
  draftPut,
  draftRemove,
  sync,
  type LocalMedia,
} from './outbox';

type Journal = {
  draft: true;
  id: string;
  roomId: string;
  segmentId: string;
  sessionId?: string;
  mime: string;
  startedAt: number;
  lastAt?: number;
  chunks: ArrayBuffer[];
};
type Options = {
  scope: string;
  inspectionId: string;
  path: string;
  state: (recording: boolean) => void;
  error: (message: string) => void;
};

// Serialized transitions keep late recorder callbacks bound to their original room.
export class RoomAudio {
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private writes: Promise<unknown> = Promise.resolve();
  private transitions: Promise<void> = Promise.resolve();
  private stopResult?: Promise<void>;
  private rotation?: ReturnType<typeof setTimeout>;
  private room = '';
  private muted = false;
  private active = false;
  private segment = uuid();
  private readonly session = uuid();
  private readonly key: string;
  constructor(private options: Options) {
    this.key = `${options.scope}:inspectionDraft:${options.inspectionId}:audio`;
  }
  private serial(action: () => Promise<void>) {
    const next = this.transitions.catch(() => {}).then(action);
    this.transitions = next;
    return next;
  }
  async recover() {
    const saved = await draftGet<Journal>(this.key);
    if (saved?.chunks.length) await this.commit(saved);
    else if (saved) await draftRemove(this.key);
  }
  start(room: string) {
    return this.serial(async () => {
      if (this.recorder?.state === 'recording' && this.room === room) return;
      await this.stop();
      this.room = room;
      this.active = true;
      await this.begin();
    });
  }
  setRoom(room: string) {
    return this.serial(async () => {
      await this.stop();
      this.room = room;
      this.segment = uuid();
      await this.begin().catch((error) => this.options.error(String(error)));
    });
  }
  setMuted(value: boolean) {
    return this.serial(async () => {
      await this.stop();
      this.muted = value;
      this.segment = uuid();
      await this.begin();
    });
  }
  pause() {
    this.active = false;
    return this.serial(async () => {
      this.active = false;
      await this.stop();
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = undefined;
    });
  }
  private async begin() {
    if (!this.active || this.muted || document.hidden || !this.room) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
      throw new Error('Audio opnemen is hier niet beschikbaar. Foto’s maken blijft mogelijk.');
    if (!this.stream || this.stream.getAudioTracks().some((t) => t.readyState === 'ended'))
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!this.active || document.hidden) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = undefined;
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    const recorder = new MediaRecorder(
      this.stream,
      mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined,
    );
    const journal: Journal = {
      draft: true,
      id: uuid(),
      roomId: this.room,
      segmentId: this.segment,
      sessionId: this.session,
      mime: recorder.mimeType.split(';')[0],
      startedAt: Date.now(),
      chunks: [],
    };
    let bytes = 0;
    await draftPut(this.key, journal);
    this.recorder = recorder;
    this.stopResult = new Promise<void>((resolve, reject) => {
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        this.writes = this.writes.then(async () => {
          const part = await event.data.arrayBuffer();
          journal.chunks.push(part);
          journal.lastAt = Date.now();
          bytes += part.byteLength;
          await draftPut(this.key, journal);
        });
        void this.writes.catch((error) => {
          this.active = false;
          this.options.error(`Audio opslaan mislukt: ${String(error)}`);
          clearTimeout(this.rotation);
          if (recorder.state !== 'inactive') recorder.stop();
          this.stream?.getTracks().forEach((track) => track.stop());
        });
        if (bytes > 40 * 1048576)
          void this.serial(async () => {
            await this.stop();
            await this.begin();
          }).catch((error) => this.options.error(String(error)));
      };
      recorder.onstop = () => {
        this.options.state(false);
        void this.writes.then(() => this.commit(journal)).then(resolve, reject);
      };
      recorder.onerror = () => {
        this.options.error('Audio onderbroken. De beschikbare opname wordt bewaard.');
        if (recorder.state !== 'inactive') recorder.stop();
      };
    });
    // Keep a rejection handler attached even before an explicit stop is awaited.
    void this.stopResult.catch((error) =>
      this.options.error(`Audio niet volledig opgeslagen: ${String(error)}`),
    );
    recorder.start(2000);
    this.options.state(true);
    this.rotation = setTimeout(() => {
      void this.serial(async () => {
        await this.stop();
        await this.begin();
      }).catch((error) => this.options.error(String(error)));
    }, 120000);
  }
  private async stop() {
    clearTimeout(this.rotation);
    const recorder = this.recorder;
    this.recorder = undefined;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    if (this.stopResult) {
      await this.stopResult;
      this.stopResult = undefined;
    }
  }
  private async commit(journal: Journal) {
    if (!journal.chunks.length) {
      await draftRemove(this.key);
      return;
    }
    const blob = new Blob(journal.chunks, { type: journal.mime });
    if (blob.size > 50 * 1048576)
      throw new Error('Audiofragment te groot. Bewaarde audio blijft op dit apparaat.');
    const file: LocalMedia = {
      id: journal.id,
      name: `Audio-${journal.id}.${journal.mime.includes('mp4') ? 'm4a' : journal.mime.includes('ogg') ? 'ogg' : 'webm'}`,
      mime: journal.mime,
      bytes: await blob.arrayBuffer(),
      duration: Math.min(600, ((journal.lastAt || journal.startedAt) - journal.startedAt) / 1000),
      captureSessionId: journal.sessionId || this.session,
      audioSegmentId: journal.segmentId,
      recordedAt: new Date(journal.startedAt).toISOString(),
    };
    await commitCaptureDraft(this.key, {
      id: journal.id,
      scope: this.options.scope,
      inspectionId: this.options.inspectionId,
      kind: 'capture',
      path: `${this.options.path}/batches`,
      payload: { id: journal.id, roomId: journal.roomId, mediaIds: [file.id] },
      files: [file],
      uploaded: [],
      createdAt: journal.startedAt,
      state: 'pending',
    });
    void sync(this.options.scope);
  }
}
