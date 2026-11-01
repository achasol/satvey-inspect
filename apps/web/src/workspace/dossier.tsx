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
import { DossierHistory } from './DossierActions';
import { VisitWorkflow } from './VisitWorkflow';
import { useActivity } from './activity';
import { SyncStatus } from './InternalSync';
import { PrepareOffline } from './OfflineVisits';
import { RenameRoom } from './EvidenceControls';

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
    [addedRoomId, setAddedRoomId] = useState(''),
    [cameraOpen, setCameraOpen] = useState(false),
    [cameraLive, setCameraLive] = useState(false),
    [expandedRooms, setExpandedRooms] = useState<Record<string, boolean>>({});
  useActivity({
    base,
    scope,
    inspectionId,
    phase: stage,
    roomId,
    capturing: cameraOpen && cameraLive,
    enabled: can(org, 'inspections.write'),
  });
  const navigate = useNavigate();

  const write =
    can(org, 'inspections.write') &&
    data?.inspection.status !== 'final' &&
    !data?.inspection.archivedAt;

  useEffect(() => {
    if (data && !roomId) setRoomId(data.rooms[0]?.id || '');
  }, [data, roomId]);
  useEffect(() => {
    if (!addedRoomId || !data?.rooms.some((room) => room.id === addedRoomId)) return;
    document
      .getElementById(`room-nav-${addedRoomId}`)
      ?.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    setAddedRoomId('');
  }, [addedRoomId, data?.rooms]);
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
            <details>
              <summary>Meer acties</summary>
              <DeleteInspection
                canManage={can(org, 'inspections.archive')}
                canPurge={can(org, 'inspections.purge')}
                base={base}
                scope={scope}
                inspection={data.inspection}
                onDeleted={() => navigate('/app', { replace: true })}
              />
            </details>
          )}
        </div>
      </div>

      {error && (
        <ErrorNotice>
          {cached ? 'Offline: dit dossier is op je apparaat beschikbaar.' : error}
        </ErrorNotice>
      )}

      <nav className={s.stages} aria-label="Inspectiestappen">
        {[
          ['capture', 'Opnemen', Camera],

          ['review', 'Beoordelen', CheckCheck],

          ['report', 'Rapport', ClipboardList],
          ['dossier', 'Dossier', House],
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
          onActivityChange={setCameraLive}
          onRoomChange={setRoomId}
          onClose={() => setCameraOpen(false)}
        />
      )}
      {stage === 'dossier' || stage === 'handover' ? (
        <section className={s.stack}>
          <h2>Dossier</h2>
          <SyncStatus base={base} path={path} scope={scope} admin={can(org, 'settings.manage')} />
          <details>
            <summary>Sjabloon en kwaliteitskader</summary>
            <p>
              {data.format?.name} · versie {data.format?.number}
            </p>
            <p>
              {data.norms?.name} · versie {data.norms?.number}
            </p>
          </details>
          <DossierHistory
            path={path}
            inspection={data.inspection}
            canWrite={can(org, 'inspections.write')}
            canManage={can(org, 'settings.manage')}
          />
          {data.inspection.archivedAt && (
            <p className={s.warning}>Gearchiveerd: {data.inspection.archiveReason}</p>
          )}
          <PrepareOffline scope={scope} path={path} />
          <VisitWorkflow
            path={path}
            base={base}
            scope={scope}
            data={data}
            org={org}
            pending={local}
          />
          <InspectionProperty
            inspection={data.inspection}
            base={base}
            scope={scope}
            canWrite={!!write}
            canManage={can(org, 'settings.manage')}
          />
        </section>
      ) : stage === 'report' ? (
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
                <div key={room.id} className={s.roomNavItem}>
                  <button
                    id={`room-nav-${room.id}`}
                    className={room.id === roomId ? s.selectedRoom : ''}
                    aria-current={room.id === roomId ? 'location' : undefined}
                    onClick={() => {
                      setRoomId(room.id);
                      setExpandedRooms((ids) => ({ ...ids, [room.id]: true }));
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
                  {write && <RenameRoom room={room} path={path} />}
                </div>
              ))}
            </nav>

            {write && (
              <AddRoom
                path={path}
                data={data}
                onAdded={(id) => {
                  setRoomId(id);
                  setAddedRoomId(id);
                  setExpandedRooms((rooms) => ({ ...rooms, [id]: true }));
                }}
              />
            )}
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
                  <details
                    open={
                      stage === 'capture' ||
                      (expandedRooms[room.id] ?? room.approvedGeneration !== room.generation)
                    }
                  >
                    <summary
                      className={s.roomHeading}
                      onClick={(e) => {
                        e.preventDefault();
                        setExpandedRooms((ids) => ({
                          ...ids,
                          [room.id]: !(ids[room.id] ?? room.approvedGeneration !== room.generation),
                        }));
                      }}
                    >
                      <h2>{room.name}</h2>
                      <span className={s.muted}>
                        {data.batches.filter((b) => b.roomId === room.id).length} opnamen
                      </span>
                    </summary>
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
                  </details>
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
