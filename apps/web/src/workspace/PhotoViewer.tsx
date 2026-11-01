import { PhotoLocation } from './PhotoLocation';
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  ArrowUpRight,
  Circle,
  Hand,
  Pencil,
  Redo2,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button, Dialog } from '../components/ui';
import { api, mediaURL } from './api';
import type { Media, PhotoAnnotation, PhotoPoint } from './api';
import { actions, draftGet, draftPut, draftRemove, enqueueEdit, removeAction } from './outbox';
import s from './photo.module.css';

type Editing = { scope: string; path: string; inspectionId: string };
type SavedDrawing = { draft: true; shapes: PhotoAnnotation[]; version: number };
const colors = ['#dc2626', '#eab308', '#2563eb'] as const;

export function AnnotationShapes({
  shapes,
  width,
  height,
}: {
  shapes: PhotoAnnotation[];
  width: number;
  height: number;
}) {
  const stroke = Math.min(width, height) * 0.006;
  return (
    <>
      {shapes.map((shape, i) => {
        const a = shape.points[0],
          b = shape.points[shape.points.length - 1];
        if (!a || !b) return null;
        let element;
        if (shape.tool === 'pen')
          element = (
            <polyline
              points={shape.points.map((p) => `${p.x * width},${p.y * height}`).join(' ')}
            />
          );
        else if (shape.tool === 'ellipse')
          element = (
            <ellipse
              cx={((a.x + b.x) * width) / 2}
              cy={((a.y + b.y) * height) / 2}
              rx={(Math.abs(a.x - b.x) * width) / 2}
              ry={(Math.abs(a.y - b.y) * height) / 2}
            />
          );
        else {
          const angle = Math.atan2((b.y - a.y) * height, (b.x - a.x) * width),
            length = stroke * 4;
          element = (
            <path
              d={`M ${a.x * width} ${a.y * height} L ${b.x * width} ${b.y * height} M ${b.x * width - length * Math.cos(angle - 0.5)} ${b.y * height - length * Math.sin(angle - 0.5)} L ${b.x * width} ${b.y * height} L ${b.x * width - length * Math.cos(angle + 0.5)} ${b.y * height - length * Math.sin(angle + 0.5)}`}
            />
          );
        }
        return (
          <g
            key={i}
            fill="none"
            stroke={shape.color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {element}
          </g>
        );
      })}
    </>
  );
}

export function PhotoTile({
  media,
  org,
  editing,
}: {
  media: Media;
  org: string;
  editing?: Editing;
}) {
  const [open, setOpen] = useState(false),
    [shapes, setShapes] = useState(media.annotations || []),
    [size, setSize] = useState({ w: 1, h: 1 });
  useEffect(() => setShapes(media.annotations || []), [media.annotations]);
  return (
    <>
      <button
        className={s.tile}
        aria-label={`Foto bekijken: ${media.name}`}
        onClick={() => setOpen(true)}
      >
        <img
          src={mediaURL(org, media.id)}
          alt={media.name}
          loading="lazy"
          onLoad={(e) =>
            setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
        />
        <svg viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true">
          <AnnotationShapes shapes={shapes} width={size.w} height={size.h} />
        </svg>
        {!!shapes.length && <span className={s.marked}>Gemarkeerd</span>}
      </button>
      {open && (
        <PhotoViewer
          media={media}
          org={org}
          editing={editing}
          onClose={() => setOpen(false)}
          onSaved={setShapes}
        />
      )}
    </>
  );
}

function PhotoViewer({
  media,
  org,
  editing,
  onClose,
  onSaved,
}: {
  media: Media;
  org: string;
  editing?: Editing;
  onClose: () => void;
  onSaved: (shapes: PhotoAnnotation[]) => void;
}) {
  const endpoint = `${editing?.path}/media/${media.id}/annotations`,
    key = `${editing?.scope}:inspectionDraft:${editing?.inspectionId}:annotations:${media.id}`;
  const [shapes, setShapes] = useState<PhotoAnnotation[]>(media.annotations || []),
    [redo, setRedo] = useState<PhotoAnnotation[]>([]),
    [current, setCurrent] = useState<PhotoAnnotation>(),
    [tool, setTool] = useState<PhotoAnnotation['tool'] | 'view'>('view'),
    [color, setColor] = useState<PhotoAnnotation['color']>(colors[0]),
    [size, setSize] = useState({ w: 1, h: 1 }),
    [zoom, setZoom] = useState(1),
    [ready, setReady] = useState(!editing),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false),
    [queued, setQueued] = useState(false),
    [dirty, setDirty] = useState(false),
    [version, setVersion] = useState(media.annotationVersion || 0);
  const [conflict, setConflict] = useState<{
    actionId: string;
    shapes: PhotoAnnotation[];
    version: number;
  }>();
  const svg = useRef<SVGSVGElement>(null),
    pointer = useRef<number | null>(null),
    drawing = useRef<PhotoAnnotation | undefined>(undefined),
    writes = useRef<Promise<unknown>>(Promise.resolve());
  const editingScope = editing?.scope;
  useEffect(() => {
    if (!editingScope) return;
    let alive = true;
    void Promise.all([
      draftGet<SavedDrawing>(key),
      actions(editingScope),
      api<{ shapes: PhotoAnnotation[]; version: number }>(endpoint).catch(() => null),
    ])
      .then(([draft, pending, latest]) => {
        if (!alive) return;
        const action = pending.find((a) => a.path === endpoint);
        if (action) {
          setShapes(action.payload.shapes as PhotoAnnotation[]);
          setQueued(true);
          if (action.state === 'conflict' && latest)
            setConflict({ actionId: action.id, ...latest });
        } else if (draft) {
          setShapes(draft.shapes);
          setVersion(draft.version);
          setDirty(true);
        } else if (latest) {
          setShapes(latest.shapes);
          setVersion(latest.version);
        }
        setReady(true);
      })
      .catch((e) => setError(String(e)));
    return () => {
      alive = false;
    };
  }, [key, endpoint, editingScope]);
  function persist(next: PhotoAnnotation[]) {
    setShapes(next);
    setDirty(true);
    writes.current = writes.current
      .catch(() => {})
      .then(() => draftPut(key, { draft: true, shapes: next, version }))
      .catch((e) => {
        setError(`Niet op apparaat opgeslagen: ${String(e)}`);
        throw e;
      });
    void writes.current.catch(() => {});
  }
  function point(e: ReactPointerEvent<SVGSVGElement>): PhotoPoint {
    const matrix = svg.current!.getScreenCTM()!;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    return { x: Math.max(0, Math.min(1, p.x / size.w)), y: Math.max(0, Math.min(1, p.y / size.h)) };
  }
  function start(e: ReactPointerEvent<SVGSVGElement>) {
    if (
      tool === 'view' ||
      !ready ||
      queued ||
      saving ||
      pointer.current !== null ||
      (e.pointerType === 'mouse' && e.button !== 0)
    )
      return;
    if (shapes.length >= 200) {
      setError('Maximaal 200 markeringen per foto.');
      return;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointer.current = e.pointerId;
    const p = point(e);
    drawing.current = { tool, color, points: [p, p] };
    setCurrent(drawing.current);
  }
  function move(e: ReactPointerEvent<SVGSVGElement>) {
    if (pointer.current !== e.pointerId || !drawing.current) return;
    const p = point(e),
      shape = drawing.current;
    if (shape.tool === 'pen' && shape.points.length >= 2000) return;
    drawing.current = {
      ...shape,
      points: shape.tool === 'pen' ? [...shape.points, p] : [shape.points[0], p],
    };
    setCurrent(drawing.current);
  }
  function end(e: ReactPointerEvent<SVGSVGElement>, cancel = false) {
    if (pointer.current !== e.pointerId) return;
    const shape = drawing.current;
    pointer.current = null;
    drawing.current = undefined;
    setCurrent(undefined);
    if (!cancel && shape) {
      if (shapes.reduce((n, s) => n + s.points.length, shape.points.length) > 12000) {
        setError('Te veel tekenpunten. Verwijder enkele markeringen.');
        return;
      }
      persist([...shapes, shape]);
      setRedo([]);
    }
  }
  async function finish() {
    if (saving || pointer.current !== null) return;
    setSaving(true);
    setError('');
    try {
      if (dirty && editing) {
        await writes.current;
        await enqueueEdit(editing.scope, editing.inspectionId, endpoint, { shapes, version });
        await draftRemove(key);
      }
      onSaved(shapes);
      onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }
  async function resolveConflict(useLocal: boolean) {
    if (!conflict || !editing) return;
    try {
      // Persist the rebased local copy before removing its failed outbox action.
      if (useLocal) await draftPut(key, { draft: true, shapes, version: conflict.version });
      else await draftRemove(key);
      await removeAction(conflict.actionId);
      if (!useLocal) setShapes(conflict.shapes);
      setVersion(conflict.version);
      setDirty(useLocal);
      setQueued(false);
      setConflict(undefined);
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <Dialog
      open
      wide
      fullOnMobile
      touch
      title={editing ? 'Foto markeren' : 'Foto bekijken'}
      description={media.name}
      closeLabel="Foto sluiten"
      onOpenChange={(open) => {
        if (!open) void finish();
      }}
    >
      <div className={s.editor}>
        {editing && (
          <PhotoLocation
            media={media}
            path={editing.path}
            scope={editing.scope}
            disabled={dirty || queued || saving}
            onMoved={onClose}
          />
        )}
        <div className={s.toolbar} aria-label="Fotogereedschappen">
          {editing && (
            <div className={s.tools}>
              {(
                [
                  ['pen', 'Pen', Pencil],
                  ['arrow', 'Pijl', ArrowUpRight],
                  ['ellipse', 'Cirkel', Circle],
                  ['view', 'Verplaatsen', Hand],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  aria-label={label}
                  aria-pressed={tool === value}
                  disabled={!ready || queued || saving}
                  onClick={() => setTool(value)}
                >
                  <Icon size={21} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          )}
          <div className={s.tools}>
            <button
              aria-label="Uitzoomen"
              disabled={zoom <= 1}
              onClick={() => setZoom((z) => Math.max(1, z - 0.5))}
            >
              <ZoomOut size={21} />
            </button>
            <button
              aria-label="Inzoomen"
              disabled={zoom >= 3}
              onClick={() => setZoom((z) => Math.min(3, z + 0.5))}
            >
              <ZoomIn size={21} />
            </button>
          </div>
        </div>
        {editing && (
          <div className={s.toolbar}>
            <div className={s.tools} aria-label="Markeringskleur">
              {colors.map((value, i) => (
                <button
                  key={value}
                  aria-label={['Rood', 'Geel', 'Blauw'][i]}
                  aria-pressed={color === value}
                  disabled={queued || saving}
                  onClick={() => setColor(value)}
                >
                  <span className={s.swatch} style={{ backgroundColor: value }} />
                </button>
              ))}
            </div>
            <div className={s.tools}>
              <button
                aria-label="Ongedaan maken"
                disabled={!shapes.length || queued || !ready || saving}
                onClick={() => {
                  setRedo([...redo, shapes[shapes.length - 1]]);
                  persist(shapes.slice(0, -1));
                }}
              >
                <Undo2 size={21} />
              </button>
              <button
                aria-label="Opnieuw uitvoeren"
                disabled={!redo.length || queued || saving}
                onClick={() => {
                  persist([...shapes, redo[redo.length - 1]]);
                  setRedo(redo.slice(0, -1));
                }}
              >
                <Redo2 size={21} />
              </button>
              <button
                aria-label="Alles wissen"
                disabled={!shapes.length || queued || !ready || saving}
                onClick={() => {
                  setRedo([...shapes].reverse());
                  persist([]);
                }}
              >
                <Trash2 size={21} />
                <span>Alles wissen</span>
              </button>
            </div>
          </div>
        )}
        <div
          className={s.viewport}
          tabIndex={0}
          role="region"
          aria-label="Foto vergroten en verschuiven"
        >
          <div className={s.surface} style={{ width: `${zoom * 100}%` }}>
            <img
              src={mediaURL(org, media.id)}
              alt={media.name}
              draggable={false}
              onLoad={(e) =>
                setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
              }
            />
            <svg
              ref={svg}
              viewBox={`0 0 ${size.w} ${size.h}`}
              aria-label="Tekenvlak"
              role="img"
              style={{
                touchAction: tool === 'view' ? 'auto' : 'none',
                pointerEvents: tool === 'view' ? 'none' : 'auto',
              }}
              onPointerDown={start}
              onPointerMove={move}
              onPointerUp={(e) => end(e)}
              onPointerCancel={(e) => end(e, true)}
            >
              <AnnotationShapes
                shapes={current ? [...shapes, current] : shapes}
                width={size.w}
                height={size.h}
              />
            </svg>
          </div>
        </div>
        {conflict ? (
          <section className={s.comparison} aria-label="Fotomarkeringen vergelijken">
            <h3>De server heeft andere markeringen</h3>
            <p>Hierboven: jouw lokale markeringen. Hieronder: de nieuwste versie op de server.</p>
            <div className={s.surface}>
              <img src={mediaURL(org, media.id)} alt="Foto met markeringen op de server" />
              <svg viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true">
                <AnnotationShapes shapes={conflict.shapes} width={size.w} height={size.h} />
              </svg>
            </div>
            <div className={s.toolbar}>
              <Button variant="secondary" onClick={() => void resolveConflict(false)}>
                Servermarkeringen gebruiken
              </Button>
              <Button onClick={() => void resolveConflict(true)}>
                Mijn markeringen verder bewerken
              </Button>
            </div>
          </section>
        ) : (
          queued && (
            <p role="status">
              Markeringen wachten op synchronisatie. Bij een conflict: sluit de foto en open deze
              opnieuw om te vergelijken.
            </p>
          )
        )}
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        <div className={s.footer}>
          <a href={mediaURL(org, media.id)} target="_blank" rel="noreferrer">
            Origineel openen
          </a>
          <Button loading={saving} disabled={!ready} onClick={() => void finish()}>
            Gereed
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
