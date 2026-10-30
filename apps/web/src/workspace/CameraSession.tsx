import { useEffectEvent, useEffect, useRef, useState } from 'react';
import { ArrowRight, Camera, ChevronDown, RefreshCw } from 'lucide-react';
import { Button, Dialog } from '../components/ui';
import { uuid } from './api';
import type { Dossier } from './api';
import { commitCaptureDraft, draftGet, draftPut, sync } from './outbox';
import type { LocalMedia } from './outbox';
import s from './camera.module.css';

type Visit = { draft: true; id: string; roomId: string; files: LocalMedia[] };

export function CameraSession({
  scope,
  path,
  data,
  initialRoomId,
  onRoomChange,
  onClose,
}: {
  scope: string;
  path: string;
  data: Dossier;
  initialRoomId: string;
  onRoomChange: (id: string) => void;
  onClose: () => void;
}) {
  const key = `${scope}:inspectionDraft:${data.inspection.id}:camera`;
  const [roomId, setRoomId] = useState(initialRoomId),
    [ready, setReady] = useState(false),
    [live, setLive] = useState(false),
    [busy, setBusy] = useState(false),
    [choose, setChoose] = useState(false),
    [error, setError] = useState(''),
    [cameraError, setCameraError] = useState(''),
    [files, setFiles] = useState<LocalMedia[]>([]),
    [notice, setNotice] = useState(''),
    [thumb, setThumb] = useState('');
  const video = useRef<HTMLVideoElement>(null),
    stream = useRef<MediaStream | null>(null),
    visit = useRef<Visit>({ draft: true, id: uuid(), roomId: initialRoomId, files: [] }),
    active = useRef(true),
    locked = useRef(false),
    request = useRef(0),
    input = useRef<HTMLInputElement>(null);

  function stopCamera() {
    request.current++;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setLive(false);
  }
  async function startCamera() {
    const token = ++request.current;
    setCameraError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError(
        'Live camera is hier niet beschikbaar. Gebruik de toestelcamera of open de app via HTTPS.',
      );
      return;
    }
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 2560 },
          height: { ideal: 1920 },
        },
        audio: false,
      });
      if (!active.current || token !== request.current || document.hidden) {
        next.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = next;
      if (video.current) {
        video.current.srcObject = next;
        await video.current.play();
      }
      next.getVideoTracks().forEach((t) =>
        t.addEventListener('ended', () => {
          if (active.current && stream.current === next) {
            setLive(false);
            setCameraError('Camera onderbroken. Je foto’s zijn bewaard; hervat om verder te gaan.');
          }
        }),
      );
      if (active.current && token === request.current) setLive(true);
    } catch (e) {
      if (active.current && token === request.current) {
        stream.current?.getTracks().forEach((t) => t.stop());
        stream.current = null;
        setLive(false);
        setCameraError(
          e instanceof DOMException && e.name === 'NotAllowedError'
            ? 'Cameratoegang geweigerd. Geef toestemming in je browser of gebruik de toestelcamera.'
            : 'De camera kon niet worden geopend. Probeer opnieuw of gebruik de toestelcamera.',
        );
      }
    }
  }
  const recoverRoom = useEffectEvent(onRoomChange);
  const closeCamera = useEffectEvent(() => {
    active.current = false;
    request.current++;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  });
  useEffect(() => {
    let cancelled = false;
    active.current = true;
    void draftGet<Visit>(key)
      .then((saved) => {
        if (cancelled) return;
        if (saved?.files.length) {
          visit.current = saved;
          setFiles(saved.files);
          setRoomId(saved.roomId);
          recoverRoom(saved.roomId);
          setNotice('Eerdere camerasessie hersteld.');
        }
        setReady(true);
      })
      .catch((e) => setError(`Herstellen mislukt: ${String(e)}`));
    // StrictMode's discarded mount must not open a second hardware stream.
    queueMicrotask(() => {
      if (!cancelled) void startCamera();
    });
    const hide = () => {
      if (document.hidden) {
        stopCamera();
        setCameraError('Camera gepauzeerd. Je foto’s blijven op dit apparaat bewaard.');
      }
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      cancelled = true;
      closeCamera();
      document.removeEventListener('visibilitychange', hide);
    };
  }, [key]);
  useEffect(() => {
    const last = files[files.length - 1];
    if (!last) {
      setThumb('');
      return;
    }
    const url = URL.createObjectURL(new Blob([last.bytes], { type: last.mime }));
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [files]);

  async function store(additions: LocalMedia[]) {
    // Keep every upload within the API's 30-file limit without closing the camera.
    for (let offset = 0; offset < additions.length;) {
      if (visit.current.files.length === 30) await seal();
      const part = additions.slice(offset, offset + 30 - visit.current.files.length);
      const next = { ...visit.current, files: [...visit.current.files, ...part] };
      // Change visible state only after IndexedDB confirms durable local storage.
      await draftPut(key, next);
      visit.current = next;
      setFiles(next.files);
      offset += part.length;
    }
    setNotice('Foto op apparaat bewaard.');
  }
  async function takePhoto() {
    if (locked.current || !live || !ready || !video.current?.videoWidth) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      const canvas = document.createElement('canvas'),
        source = video.current;
      const scale = Math.min(1, 4096 / Math.max(source.videoWidth, source.videoHeight));
      canvas.width = Math.round(source.videoWidth * scale);
      canvas.height = Math.round(source.videoHeight * scale);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Foto kon niet worden vastgelegd.');
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(new Error('Foto kon niet worden vastgelegd.')),
          'image/jpeg',
          0.92,
        ),
      );
      if (blob.size > 20 * 1024 * 1024) throw new Error('Deze foto is te groot. Probeer opnieuw.');
      await store([
        {
          id: uuid(),
          name: `Foto-${new Date().toISOString().replaceAll(':', '-')}.jpg`,
          mime: 'image/jpeg',
          bytes: await blob.arrayBuffer(),
          duration: 0,
        },
      ]);
    } catch (e) {
      setError(`Foto niet opgeslagen. ${String(e)}`);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function seal() {
    const saved = visit.current;
    if (!saved.files.length) return;
    await commitCaptureDraft(key, {
      id: saved.id,
      scope,
      inspectionId: data.inspection.id,
      kind: 'capture',
      path: `${path}/batches`,
      payload: { id: saved.id, roomId: saved.roomId, mediaIds: saved.files.map((f) => f.id) },
      files: saved.files,
      uploaded: [],
      createdAt: Date.now(),
      state: 'pending',
    });
    visit.current = { draft: true, id: uuid(), roomId: saved.roomId, files: [] };
    setFiles([]);
    void sync(scope);
  }
  async function switchRoom(id: string) {
    if (locked.current || !ready || id === roomId) {
      setChoose(false);
      return;
    }
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await seal();
      visit.current.roomId = id;
      setRoomId(id);
      onRoomChange(id);
      setChoose(false);
      setNotice('Ruimte gewijzigd. Je kunt verder fotograferen.');
    } catch (e) {
      setError(`Wisselen mislukt; je foto’s blijven bewaard. ${String(e)}`);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function close() {
    if (locked.current || !ready) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await seal();
      stopCamera();
      onClose();
    } catch (e) {
      setError(`Opslaan mislukt. Houd dit scherm open. ${String(e)}`);
      locked.current = false;
      setBusy(false);
    }
  }
  const nextRoom = data.rooms[data.rooms.findIndex((r) => r.id === roomId) + 1];
  return (
    <Dialog
      open
      wide
      fullOnMobile
      touch
      title="Camera"
      description="Maak foto’s en wissel van ruimte zonder de camera te sluiten."
      closeLabel="Camera sluiten"
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <div className={s.camera}>
        <div className={s.view}>
          <video ref={video} playsInline muted aria-label="Live camerabeeld" />
          <div className={s.topbar}>
            <button
              className={s.roomButton}
              disabled={busy || !ready}
              aria-expanded={choose}
              onClick={() => setChoose((v) => !v)}
            >
              {data.rooms.find((r) => r.id === roomId)?.name || 'Kies ruimte'}{' '}
              <ChevronDown size={20} />
            </button>
            <span className={s.counter}>{files.length} foto’s</span>
          </div>
          {choose && (
            <div className={s.roomPicker} aria-label="Cameraruimte">
              {data.rooms.map((room) => (
                <button
                  key={room.id}
                  aria-pressed={room.id === roomId}
                  disabled={busy}
                  onClick={() => void switchRoom(room.id)}
                >
                  {room.name}
                </button>
              ))}
            </div>
          )}
          {!live && (
            <div className={s.paused}>
              <p>{cameraError || 'Camera openen…'}</p>
              {cameraError && (
                <Button
                  variant="secondary"
                  icon={<RefreshCw size={18} />}
                  onClick={() => void startCamera()}
                >
                  Camera hervatten
                </Button>
              )}
            </div>
          )}
          <div className={s.bottomBar}>
            <div className={s.thumbnail}>
              {thumb && <img src={thumb} alt="Laatste opgeslagen foto" />}
            </div>
            <button
              className={s.shutter}
              disabled={!live || !ready || busy || choose}
              aria-label="Foto vastleggen"
              onClick={() => void takePhoto()}
            >
              <Camera size={30} />
            </button>
            {nextRoom ? (
              <button
                className={s.nextRoom}
                disabled={busy || !ready}
                onClick={() => void switchRoom(nextRoom.id)}
                aria-label={`Volgende ruimte: ${nextRoom.name}`}
              >
                <ArrowRight size={24} />
                <span>Volgende ruimte</span>
              </button>
            ) : (
              <span className={s.nextRoom} />
            )}
          </div>
        </div>
        <div className={s.footer}>
          <Button variant="ghost" disabled={busy || !ready} onClick={() => input.current?.click()}>
            Toestelcamera / foto toevoegen
          </Button>
          <Button loading={busy} disabled={!ready} onClick={() => void close()}>
            Gereed
          </Button>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          multiple
          hidden
          disabled={busy || !ready}
          aria-label="Foto toevoegen in camerasessie"
          onChange={async (e) => {
            const selected = Array.from(e.target.files || []);
            e.target.value = '';
            if (locked.current || !ready) return;
            locked.current = true;
            setBusy(true);
            setError('');
            try {
              const additions: LocalMedia[] = [];
              for (const file of selected) {
                if (
                  !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
                  file.size > 20 * 1024 * 1024
                )
                  throw new Error('Gebruik JPG, PNG of WebP van maximaal 20 MB.');
                additions.push({
                  id: uuid(),
                  name: file.name,
                  mime: file.type,
                  bytes: await file.arrayBuffer(),
                  duration: 0,
                });
              }
              await store(additions);
            } catch (error) {
              setError(String(error));
            } finally {
              locked.current = false;
              setBusy(false);
            }
          }}
        />
        {notice && (
          <p role="status" className={s.notice}>
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
