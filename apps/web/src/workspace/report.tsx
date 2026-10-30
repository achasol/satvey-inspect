import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { Badge, BrandMark, Button, Dialog } from '../components/ui';
import { api, json, reportPDF } from './api';
import type { Dossier, Organisation, Report, SignatureInput } from './api';
import { actions, pendingDraftCount, sync } from './outbox';
import type { Action } from './outbox';
import { outcomeLabels } from './labels';
import { ReportSignatures, SignaturesEditor } from './Signatures';
import { FormatReportResults } from './FormatReview';
import { PropertyFacts } from './Properties';
import s from './workspace.module.css';
import { errorText, kindLabel, dateLabel, announceRefresh, ErrorNotice } from './shared';
import { Gallery } from './capture';

export function ReportView({
  org,

  scope,

  path,

  data,

  pending,

  canWrite,
}: {
  org: Organisation;

  scope: string;

  path: string;

  data: Dossier;

  pending: Action[];

  canWrite: boolean;
}) {
  const [report, setReport] = useState<Report>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [pdfBusy, setPDFBusy] = useState(false),
    [finaliseOpen, setFinaliseOpen] = useState(false),
    [signatures, setSignatures] = useState<SignatureInput[]>([]);

  const [draftCount, setDraftCount] = useState<number>();

  const observationKey = data.observations

    .map((o) => o.id)

    .sort()

    .join(',');

  useEffect(() => {
    let alive = true;

    const check = () => {
      void pendingDraftCount(scope, data.inspection.id, observationKey.split(',').filter(Boolean))
        .then((count) => {
          if (alive) setDraftCount(count);
        })

        .catch((e) => {
          if (alive) setError(errorText(e));
        });
    };

    check();

    window.addEventListener('satvey-drafts', check);

    return () => {
      alive = false;

      window.removeEventListener('satvey-drafts', check);
    };
  }, [scope, data.inspection.id, observationKey]);

  useEffect(() => {
    if (data.inspection.status === 'final')
      void api<Report>(`${path}/report`)
        .then(setReport)

        .catch((e) => setError(errorText(e)));
  }, [data.inspection.status, path]);

  const approved =
    report?.observations ||
    data.observations.filter(
      (o) =>
        o.status === 'approved' &&
        data.batches.find((b) => b.id === o.batchId)?.status === 'reviewed',
    );

  const unresolved = data.format
      ? data.rooms.filter((r) => r.approvedGeneration !== r.generation).length
      : data.batches.filter((b) => b.status === 'pending').length,
    ready = data.format
      ? !unresolved && !pending.length && draftCount === 0
      : !unresolved &&
        !!data.batches.length &&
        !pending.length &&
        !(data.assessments || []).some(
          (a) =>
            data.batches.find((b) => b.id === a.batchId)?.status !== 'excluded' &&
            (!a.reviewedOutcome || a.stale),
        ) &&
        draftCount === 0 &&
        !data.jobs.some(
          (j) =>
            j.status !== 'done' &&
            data.batches.find((b) => b.id === j.batchId)?.status !== 'excluded',
        );

  async function finalise() {
    setBusy(true);

    setError('');

    try {
      await sync(scope);

      if (
        await pendingDraftCount(
          scope,

          data.inspection.id,

          observationKey.split(',').filter(Boolean),
        )
      )
        throw new Error('Bewaar of verwijder eerst je lokale concepten.');

      if ((await actions(scope)).some((a) => a.inspectionId === data.inspection.id))
        throw new Error('Synchroniseer eerst de wijzigingen op dit apparaat.');

      const value = await api<Report>(
        `${path}/report`,
        json('POST', {
          signatures: signatures.filter(
            (signature) => signature.name.trim() || signature.strokes.length,
          ),
        }),
      );

      setReport(value);
      setFinaliseOpen(false);
      setSignatures([]);

      announceRefresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function downloadPDF() {
    setError('');

    setPDFBusy(true);

    try {
      if (data.inspection.status !== 'final') {
        if (
          await pendingDraftCount(
            scope,

            data.inspection.id,

            observationKey.split(',').filter(Boolean),
          )
        )
          throw new Error('Bewaar of verwijder eerst je lokale concepten.');

        if ((await actions(scope)).some((a) => a.inspectionId === data.inspection.id))
          throw new Error('Synchroniseer eerst de wijzigingen op dit apparaat.');
      }

      const { blob, filename } = await reportPDF(path);

      const url = URL.createObjectURL(blob),
        link = document.createElement('a');

      link.href = url;

      link.download = filename;

      document.body.appendChild(link);

      link.click();

      link.remove();

      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPDFBusy(false);
    }
  }

  return (
    <section className={s.stack}>
      <div className={s.reportToolbar}>
        <div>
          <h2>{report ? 'Vastgelegd rapport' : 'Conceptrapport'}</h2>

          <p className={s.muted}>
            {approved.length} goedgekeurde bevindingen
            {unresolved > 0 && ` · ${unresolved} opnamen te beoordelen`}
          </p>
        </div>

        <div className={s.actions}>
          <Button
            variant="secondary"
            icon={<Download size={17} />}
            loading={pdfBusy}
            disabled={
              busy ||
              (data.inspection.status !== 'final' && (draftCount !== 0 || pending.length > 0))
            }
            onClick={() => void downloadPDF()}
          >
            {pdfBusy
              ? 'PDF maken…'
              : data.inspection.status === 'final'
                ? 'PDF downloaden'
                : 'Concept-PDF downloaden'}
          </Button>

          {canWrite && (
            <Button
              disabled={!ready || data.inspection.propertySnapshot?.linkState !== 'linked'}
              loading={busy}
              onClick={() => {
                setError('');
                setSignatures([]);
                setFinaliseOpen(true);
              }}
            >
              Rapport vastleggen
            </Button>
          )}
        </div>
      </div>

      {!!draftCount && !report && (
        <p className={s.warning}>
          Er staan nog {draftCount} concepten op dit apparaat. Bewaar of verwijder ze bij Opnemen of
          Beoordelen.
        </p>
      )}

      {pending.length > 0 && (
        <p className={s.warning}>Er staan nog {pending.length} wijzigingen op dit apparaat.</p>
      )}

      {error && !finaliseOpen && <ErrorNotice>{error}</ErrorNotice>}

      <Dialog
        open={finaliseOpen}
        onOpenChange={(open) => {
          if (!busy) setFinaliseOpen(open);
        }}
        title="Inspectie afronden"
        description={data.inspection.address}
        closeLabel="Sluiten"
        fullOnMobile
      >
        <div className={s.stack}>
          <p>
            Na het vastleggen kunnen het rapport, de opnamen en handtekeningen niet meer worden
            gewijzigd.
          </p>
          <SignaturesEditor value={signatures} onChange={setSignatures} disabled={busy} />
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <div className={s.actions}>
            <Button variant="secondary" disabled={busy} onClick={() => setFinaliseOpen(false)}>
              Annuleren
            </Button>
            <Button loading={busy} onClick={() => void finalise()}>
              Rapport definitief vastleggen
            </Button>
          </div>
        </div>
      </Dialog>

      <article className={s.report} aria-label="Inspectierapport">
        <header>
          <BrandMark size={28} />

          <strong>satvey.</strong>

          <span>{report ? 'Vastgelegd' : 'Concept'}</span>
        </header>

        <p className={s.eyebrow}>
          {org.name} · {kindLabel(data.inspection.kind)}
        </p>

        <h2>{data.inspection.address}</h2>

        <p>
          {data.inspection.postcode} {data.inspection.city}
        </p>

        {report && <p className={s.muted}>Vastgelegd op {dateLabel(report.createdAt)}</p>}
        {(report?.inspection.propertySnapshot || data.inspection.propertySnapshot) && (
          <section>
            <h3>Vastgoedobject</h3>
            <PropertyFacts
              property={(report?.inspection.propertySnapshot || data.inspection.propertySnapshot)!}
            />
          </section>
        )}

        <FormatReportResults
          data={report || data}
          org={org.id}
          editing={canWrite ? { scope, path, inspectionId: data.inspection.id } : undefined}
        />

        {(report?.norms || data.norms) && (
          <section>
            <h3>
              {(report?.norms || data.norms)?.name} · versie {(report?.norms || data.norms)?.number}
            </h3>

            {(
              report?.assessments ||
              (data.assessments || [])

                .filter(
                  (a) =>
                    a.reviewedOutcome &&
                    !a.stale &&
                    data.batches.find((b) => b.id === a.batchId)?.status === 'reviewed',
                )

                .map((a) => ({
                  ruleId: a.ruleId,

                  batchId: a.batchId,

                  outcome: a.reviewedOutcome!,

                  reason: a.reviewNote || a.reason,

                  photoIds: a.photoIds,
                }))
            ).map((a, index) => (
              <section key={index}>
                <strong>
                  {(report?.norms || data.norms)?.rules.find((r) => r.id === a.ruleId)?.title}
                </strong>{' '}
                · {outcomeLabels[a.outcome]}
                <p>{a.reason}</p>
                {!!a.photoIds?.length && (
                  <Gallery
                    media={(report?.media || data.media).filter(
                      (m) => m.kind === 'photo' && a.photoIds?.includes(m.id),
                    )}
                    org={org.id}
                    editing={
                      canWrite ? { scope, path, inspectionId: data.inspection.id } : undefined
                    }
                  />
                )}
              </section>
            ))}
          </section>
        )}

        {!approved.length && <p className={s.emptySmall}>Geen goedgekeurde bevindingen.</p>}

        {approved.map((o) => (
          <section key={o.id}>
            <p className={s.eyebrow}>
              {
                (report?.rooms || data.rooms).find(
                  (r) => r.id === data.batches.find((b) => b.id === o.batchId)?.roomId,
                )?.name
              }
            </p>

            <h3>{o.title}</h3>

            {o.label && <Badge>{o.label}</Badge>}

            <p className={s.description}>{o.description}</p>

            <Gallery
              media={(report?.media || data.media).filter(
                (m) =>
                  m.batchId === o.batchId &&
                  m.kind === 'photo' &&
                  (!o.photoIds?.length || o.photoIds.includes(m.id)),
              )}
              org={org.id}
              editing={canWrite ? { scope, path, inspectionId: data.inspection.id } : undefined}
            />
          </section>
        ))}
        <ReportSignatures signatures={report?.signatures || []} />
      </article>
    </section>
  );
}
