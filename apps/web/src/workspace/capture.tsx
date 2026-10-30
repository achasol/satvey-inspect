import { useEffect, useRef, useState } from 'react';
import { Camera, Mic, Square, Upload, X } from 'lucide-react';
import { Badge, Button } from '../components/ui';
import { mediaURL, uuid } from './api';
import type { Dossier, Media } from './api';
import { draftGet, draftPut, draftRemove, saveAction, sync } from './outbox';
import type { Action, LocalMedia } from './outbox';
import { TalkingGuide } from './FormatReview';
import { PhotoTile } from './PhotoViewer';
import s from './workspace.module.css';
import { errorText, ErrorNotice } from './shared';

export function LocalGallery({
  files,
  remove,
}: {
  files: LocalMedia[];
  remove?: (id: string) => void;
}) {
  return (
    <div className={s.gallery}>
      {files.map((file) => (
        <LocalPreview key={file.id} file={file} remove={remove} />
      ))}
    </div>
  );
}

export function LocalPreview({
  file,
  remove,
}: {
  file: LocalMedia;
  remove?: (id: string) => void;
}) {
  const [url, setURL] = useState('');

  useEffect(() => {
    const u = URL.createObjectURL(new Blob([file.bytes], { type: file.mime }));

    setURL(u);

    return () => URL.revokeObjectURL(u);
  }, [file.bytes, file.mime]);

  return (
    <div className={file.mime.startsWith('audio') ? s.audioPreview : s.photoPreview}>
      {file.mime.startsWith('image') ? (
        <a href={url} download={file.name}>
          <img src={url} alt={file.name} />
        </a>
      ) : (
        <>
          <audio controls src={url} aria-label={file.name} />

          <a href={url} download={file.name}>
            Audio downloaden
          </a>
        </>
      )}

      {remove && (
        <button
          type="button"
          aria-label={`${file.name} verwijderen`}
          onClick={() => remove(file.id)}
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}

export function Capture({
  scope,

  path,

  inspectionId,

  roomId,

  pending,

  data,
  onOpenCamera,
}: {
  onOpenCamera: () => void;
  data: Dossier;

  scope: string;

  path: string;

  inspectionId: string;

  roomId: string;

  pending: Action[];
}) {
  const draftKey = `${scope}:capture:${inspectionId}:${roomId}`,
    [files, setFiles] = useState<LocalMedia[]>([]),
    [error, setError] = useState(''),
    [ready, setReady] = useState(false),
    [saving, setSaving] = useState(false),
    [recording, setRecording] = useState(false),
    [seconds, setSeconds] = useState(0),
    [notice, setNotice] = useState('');

  const input = useRef<HTMLInputElement>(null),
    recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    timer = useRef<number | undefined>(undefined),
    mounted = useRef(true),
    currentFiles = useRef(files),
    audioAbort = useRef(false);

  useEffect(() => {
    let alive = true;

    mounted.current = true;

    void draftGet(draftKey)
      .then((d) => {
        if (alive) {
          setFiles(d?.files || []);

          currentFiles.current = d?.files || [];

          setReady(true);
        }
      })

      .catch((e) => setError(errorText(e)));

    return () => {
      alive = false;

      mounted.current = false;

      audioAbort.current = true;

      if (recorder.current?.state === 'recording') recorder.current.stop();

      stream.current?.getTracks().forEach((t) => t.stop());

      window.clearInterval(timer.current);
    };
  }, [draftKey]);

  async function store(next: LocalMedia[]) {
    currentFiles.current = next;

    setFiles(next);

    setNotice('');

    try {
      await draftPut(draftKey, { roomId, files: next });
    } catch (e) {
      setError(`Opslaan op apparaat mislukt. Houd dit scherm open. ${errorText(e)}`);

      throw e;
    }
  }

  async function add(selected: File[]) {
    setError('');

    const additions: LocalMedia[] = [];

    try {
      for (const file of selected) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
          throw new Error(
            'Gebruik JPG, PNG of WebP. Kies op je telefoon zo nodig een compatibel cameraformaat.',
          );

        if (file.size > 20 * 1024 * 1024) throw new Error('Maximaal 20 MB per foto.');

        additions.push({
          id: uuid(),

          name: file.name,

          mime: file.type,

          bytes: await file.arrayBuffer(),

          duration: 0,
        });
      }

      if (currentFiles.current.length + additions.length > 30)
        throw new Error('Maximaal 30 bestanden per opname.');

      await store([...currentFiles.current, ...additions]);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function startRecording() {
    setError('');

    setNotice('');

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError('Audio opnemen vereist een ondersteunde browser op localhost of HTTPS.');

      return;
    }

    if (files.length >= 30) {
      setError('Maximaal 30 bestanden per opname.');

      return;
    }

    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });

      if (!mounted.current) {
        mic.getTracks().forEach((t) => t.stop());

        return;
      }

      stream.current = mic;

      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) =>
        MediaRecorder.isTypeSupported(t),
      );

      const rec = new MediaRecorder(mic, mime ? { mimeType: mime } : undefined);

      recorder.current = rec;

      const chunks: Blob[] = [];

      const started = Date.now();

      audioAbort.current = false;

      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };

      rec.onerror = () => {
        setError('Opnemen onderbroken. Controleer de opgeslagen audio en probeer opnieuw.');

        rec.stop();
      };

      rec.onstop = () => {
        mic.getTracks().forEach((t) => t.stop());

        clearInterval(timer.current);

        if (mounted.current) setRecording(false);

        const type = rec.mimeType.split(';')[0],
          blob = new Blob(chunks, { type });

        if (audioAbort.current || !mounted.current) return;

        if (!blob.size) {
          setError('Geen audio opgenomen. Probeer opnieuw.');

          return;
        }

        if (blob.size > 50 * 1024 * 1024) {
          setError('Audio groter dan 50 MB. Maak een kortere opname.');

          return;
        }

        void blob

          .arrayBuffer()

          .then((bytes) =>
            store([
              ...currentFiles.current,

              {
                id: uuid(),

                name: `Spraaknotitie-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`,

                mime: type,

                bytes,

                duration: Math.min(600, (Date.now() - started) / 1000),
              },
            ]),
          )

          .catch((e) => setError(errorText(e)));
      };

      rec.start(1000);

      setSeconds(0);

      setRecording(true);

      timer.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1000);

        setSeconds(elapsed);

        if (elapsed >= 600 && rec.state === 'recording') rec.stop();
      }, 1000);
    } catch (e) {
      stream.current?.getTracks().forEach((t) => t.stop());

      setError(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Microfoontoegang geweigerd. Geef toestemming in je browser en probeer opnieuw.'
          : errorText(e),
      );
    }
  }

  async function save() {
    setSaving(true);

    setError('');

    try {
      const id = uuid();

      await saveAction({
        id,

        scope,

        inspectionId,

        kind: 'capture',

        path: `${path}/batches`,

        payload: { id, roomId, mediaIds: files.map((f) => f.id) },

        files,

        uploaded: [],

        createdAt: Date.now(),

        state: 'pending',
      });

      await draftRemove(draftKey);

      setFiles([]);

      currentFiles.current = [];

      setNotice('Opname op apparaat bewaard.');

      void sync(scope);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={s.capture} aria-label="Nieuwe opname">
      <div className={s.captureActions}>
        <Button
          size="lg"
          icon={<Camera size={21} />}
          onClick={onOpenCamera}
          disabled={!ready || saving || recording}
        >
          Foto maken
        </Button>

        <Button variant="ghost" onClick={() => input.current?.click()} disabled={!ready || saving}>
          Foto’s toevoegen
        </Button>
        {recording ? (
          <Button
            size="lg"
            variant="destructive"
            icon={<Square size={18} />}
            onClick={() => recorder.current?.stop()}
          >
            Stop {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
          </Button>
        ) : (
          <Button
            size="lg"
            variant="secondary"
            icon={<Mic size={21} />}
            onClick={() => void startRecording()}
            disabled={!ready || saving}
          >
            Audio opnemen
          </Button>
        )}
      </div>

      {data.format && <TalkingGuide data={data} roomId={roomId} recording={recording} />}

      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        multiple
        hidden
        aria-label="Foto's toevoegen"
        onChange={(e) => {
          void add(Array.from(e.target.files || []));

          e.target.value = '';
        }}
      />

      {recording && (
        <p className={s.recording} role="status">
          <span />
          Microfoon actief · blijf op dit scherm
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              audioAbort.current = true;

              recorder.current?.stop();
            }}
          >
            Opname verwerpen
          </Button>
        </p>
      )}

      {files.length > 0 && (
        <>
          <LocalGallery
            files={files}
            remove={(id) => {
              void store(files.filter((f) => f.id !== id)).catch(() => {});
            }}
          />

          <div className={s.captureFooter}>
            <Badge tone="warning">Concept op apparaat</Badge>

            <span>
              {files.filter((f) => f.mime.startsWith('image')).length} foto's ·{' '}
              {files.filter((f) => f.mime.startsWith('audio')).length} audio
            </span>

            <Button
              loading={saving}
              disabled={recording}
              icon={<Upload size={17} />}
              onClick={() => void save()}
            >
              Opname bewaren
            </Button>
          </div>
        </>
      )}

      {notice && (
        <p role="status" className={s.muted}>
          {notice}
        </p>
      )}

      {error && <ErrorNotice>{error}</ErrorNotice>}

      {pending

        .filter((p) => p.kind === 'capture' && p.payload.roomId === roomId)

        .map((p) => (
          <div className={s.localBatch} key={p.id}>
            <Badge tone={p.state === 'failed' || p.state === 'conflict' ? 'danger' : 'warning'}>
              {p.state === 'uploading'
                ? 'Uploaden'
                : p.state === 'pending'
                  ? 'Op apparaat'
                  : 'Mislukt'}{' '}
              · {p.uploaded?.length || 0}/{p.files?.length || 0}
            </Badge>

            <LocalGallery files={p.files || []} />
          </div>
        ))}
    </section>
  );
}

export function Gallery({
  media,
  org,
  editing,
}: {
  media: Media[];
  org: string;
  editing?: { scope: string; path: string; inspectionId: string };
}) {
  return (
    <div className={s.gallery}>
      {media.map((m) =>
        m.kind === 'photo' ? (
          <PhotoTile key={m.id} media={m} org={org} editing={editing} />
        ) : (
          <div className={s.audioPreview} key={m.id}>
            <span>
              <Mic size={15} />
              Spraaknotitie · intern
            </span>

            <audio controls preload="metadata" src={mediaURL(org, m.id)} aria-label={m.name} />
          </div>
        ),
      )}
    </div>
  );
}
