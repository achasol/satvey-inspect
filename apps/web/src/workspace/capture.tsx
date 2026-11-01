import { useEffect, useState } from 'react';
import { Camera, Mic, X } from 'lucide-react';
import { Button } from '../components/ui';
import { mediaURL, uuid } from './api';
import type { Dossier, Media } from './api';
import { draftGet, commitCaptureDraft, sync } from './outbox';
import type { Action, LocalMedia } from './outbox';
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
  data,
  onOpenCamera,
}: {
  scope: string;
  path: string;
  inspectionId: string;
  roomId: string;
  pending: Action[];
  data: Dossier;
  onOpenCamera: () => void;
}) {
  const key = `${scope}:capture:${inspectionId}:${roomId}`;
  const [files, setFiles] = useState<LocalMedia[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void draftGet<{ files?: LocalMedia[] }>(key)
      .then((d) => {
        if (alive) setFiles(d?.files || []);
      })
      .catch((e) => setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [key]);
  return (
    <section className={s.capture} aria-label="Nieuwe opname">
      <Button size="lg" icon={<Camera size={21} />} onClick={onOpenCamera}>
        Inspectie {data.batches.length ? 'hervatten' : 'starten'}
      </Button>
      <p className={s.muted}>
        Loop door de woning, maak foto’s en wissel van ruimte. Audio staat aan totdat je dempt.
      </p>
      {!!files.length && (
        <>
          <p>Eerder opgeslagen opnamen op dit apparaat</p>
          <LocalGallery files={files} />
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const id = uuid();
                await commitCaptureDraft(key, {
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
                setFiles([]);
                void sync(scope);
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Herstelde opnamen bewaren
          </Button>
        </>
      )}
      {error && <ErrorNotice>{error}</ErrorNotice>}
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
            {m.contentDeletedAt ? (
              <p>Originele audio verwijderd volgens het bewaarbeleid.</p>
            ) : (
              <audio controls preload="metadata" src={mediaURL(org, m.id)} aria-label={m.name} />
            )}
          </div>
        ),
      )}
    </div>
  );
}
