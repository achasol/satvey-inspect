import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Camera, CheckCheck, ClipboardList, House } from 'lucide-react';
import { Badge } from '../components/ui';
import { can } from './api';
import type { Dossier, Organisation } from './api';

import type { Action } from './outbox';
import { useResource } from './useResource';
import { FormatRoomReview } from './FormatReview';
import { InspectionProperty } from './Properties';
import { CameraSession } from './CameraSession';
import s from './workspace.module.css';
import { kindLabel, dateLabel, ErrorNotice, Loading } from './shared';
import { DeleteInspection, AddRoom } from './inspections';
import { Capture } from './capture';
import { BatchCard } from './observations';
import { ReportView } from './report';

export function InspectionWorkspace({
  base,

  scope,

  org,

  inspectionId,

  stage,

  pending,
}: {
  base: string;

  scope: string;

  org: Organisation;

  inspectionId: string;

  stage: string;

  pending: Action[];
}) {
  const path = `${base}/inspections/${inspectionId}`,
    { data, error, cached } = useResource<Dossier>(scope, path),
    [roomId, setRoomId] = useState(''),
    [cameraOpen, setCameraOpen] = useState(false);
  const navigate = useNavigate();

  const write = can(org, 'inspections.write') && data?.inspection.status !== 'final';

  useEffect(() => {
    if (data && !roomId) setRoomId(data.rooms[0]?.id || '');
  }, [data, roomId]);
  const reviewRoomIds = data?.rooms.map((r) => r.id).join(',') || '';
  useEffect(() => {
    if (stage !== 'review' || !reviewRoomIds) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const current = entries.find((entry) => entry.isIntersecting);
        if (current) setRoomId(current.target.id.replace('review-room-', ''));
      },
      { rootMargin: '-10% 0px -70% 0px' },
    );
    for (const id of reviewRoomIds.split(',')) {
      const element = document.getElementById(`review-room-${id}`);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [stage, reviewRoomIds]);

  if (!data)
    return (
      <>
        {error ? <ErrorNotice>{error}</ErrorNotice> : <Loading />}

        <Link to="/app">Alle inspecties</Link>
      </>
    );

  const local = pending.filter((p) => p.inspectionId === inspectionId),
    reviewed = data.format
      ? data.rooms.filter((r) => r.generation === r.approvedGeneration).length
      : data.batches.filter((b) => b.status !== 'pending').length;

  return (
    <>
      <Link to="/app" className={s.back}>
        <ArrowLeft size={16} />
        Alle inspecties
      </Link>

      <div className={s.pageHeading}>
        <div>
          <p className={s.eyebrow}>{kindLabel(data.inspection.kind)}</p>

          <h1>{data.inspection.address}</h1>

          {data.format && (
            <p className={s.muted}>
              Format: {data.format.name} · versie {data.format.number}
            </p>
          )}

          {data.norms && (
            <p className={s.muted}>
              Normenkader: {data.norms.name} · versie {data.norms.number}
            </p>
          )}

          <p className={s.muted}>
            {data.inspection.postcode} {data.inspection.city} ·{' '}
            {dateLabel(data.inspection.scheduledAt)}
          </p>
        </div>

        <div className={s.actions}>
          <Badge tone={data.inspection.status === 'final' ? 'success' : 'neutral'}>
            {data.inspection.status === 'final'
              ? 'Vastgelegd'
              : `${reviewed}/${data.format ? data.rooms.length : data.batches.length} ${data.format ? 'ruimtes' : 'opnamen'} beoordeeld`}
          </Badge>
          {can(org, 'inspections.write') && (
            <DeleteInspection
              base={base}
              scope={scope}
              inspection={data.inspection}
              onDeleted={() => navigate('/app', { replace: true })}
            />
          )}
        </div>
      </div>

      {error && (
        <ErrorNotice>
          {cached ? 'Offline: dit dossier is op je apparaat beschikbaar.' : error}
        </ErrorNotice>
      )}

      <InspectionProperty
        inspection={data.inspection}
        base={base}
        scope={scope}
        canWrite={!!write}
        canManage={can(org, 'settings.manage')}
      />

      <nav className={s.stages} aria-label="Inspectiestappen">
        {[
          ['capture', 'Opnemen', Camera],

          ['review', 'Beoordelen', CheckCheck],

          ['report', 'Rapport', ClipboardList],
        ].map(([key, label, Icon]) => {
          const I = Icon as typeof Camera;

          return (
            <Link
              key={String(key)}
              aria-current={stage === key ? 'step' : undefined}
              className={stage === key ? s.activeStage : ''}
              to={`/app/inspections/${inspectionId}/${key}`}
            >
              <I size={18} />

              {String(label)}
            </Link>
          );
        })}
      </nav>

      {cameraOpen && stage === 'capture' && write && (
        <CameraSession
          scope={scope}
          path={path}
          data={data}
          initialRoomId={roomId}
          onRoomChange={setRoomId}
          onClose={() => setCameraOpen(false)}
        />
      )}
      {stage === 'report' ? (
        <ReportView
          org={org}
          scope={scope}
          path={path}
          data={data}
          pending={local}
          canWrite={!!write}
        />
      ) : (
        <div className={s.inspectionGrid}>
          <aside className={s.rooms}>
            <h2>Ruimtes</h2>

            <nav aria-label="Ruimtes">
              {data.rooms.map((room) => (
                <button
                  key={room.id}
                  className={room.id === roomId ? s.selectedRoom : ''}
                  aria-current={room.id === roomId ? 'location' : undefined}
                  onClick={() => {
                    setRoomId(room.id);
                    if (stage === 'review')
                      document
                        .getElementById(`review-room-${room.id}`)
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  <House size={17} />

                  <span>{room.name}</span>

                  <small>
                    {data.format
                      ? room.approvedGeneration === room.generation
                        ? '\u2713'
                        : 'Open'
                      : data.batches.filter((b) => b.roomId === room.id).length}
                  </small>
                </button>
              ))}
            </nav>

            {write && <AddRoom path={path} data={data} />}
          </aside>

          <div className={s.roomContent}>
            {(stage === 'review' ? data.rooms : data.rooms.filter((r) => r.id === roomId)).map(
              (room) => (
                <section
                  key={room.id}
                  id={`review-room-${room.id}`}
                  className={s.reviewRoom}
                  aria-label={room.name}
                >
                  <div className={s.roomHeading}>
                    <h2>{room.name}</h2>
                    <span className={s.muted}>
                      {data.batches.filter((b) => b.roomId === room.id).length} opnamen
                    </span>
                  </div>
                  {stage === 'capture' && write && (
                    <Capture
                      key={room.id}
                      scope={scope}
                      path={path}
                      inspectionId={inspectionId}
                      roomId={room.id}
                      pending={local}
                      data={data}
                      onOpenCamera={() => setCameraOpen(true)}
                    />
                  )}
                  {data.batches
                    .filter((b) => b.roomId === room.id)
                    .map((batch) => (
                      <BatchCard
                        key={batch.id}
                        batch={batch}
                        data={data}
                        org={org}
                        scope={scope}
                        path={path}
                        canWrite={!!write}
                        review={stage === 'review'}
                        pending={local}
                      />
                    ))}
                  {!data.batches.some((b) => b.roomId === room.id) && (
                    <p className={s.emptySmall}>Nog geen opnamen in deze ruimte.</p>
                  )}
                  {data.format && stage === 'review' && (
                    <FormatRoomReview
                      data={data}
                      room={room}
                      path={path}
                      scope={scope}
                      org={org.id}
                      pending={local}
                      canWrite={!!write}
                    />
                  )}
                </section>
              ),
            )}
            {stage === 'capture' && (
              <Link className={s.nextLink} to={`/app/inspections/${inspectionId}/review`}>
                Opnamen beoordelen <ArrowRight size={17} />
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  );
}
