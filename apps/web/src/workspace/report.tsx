import { useLocation } from 'react-router-dom';
import { organisationTheme } from './theme';
import { ReportVersions } from './ReportVersions';
import { networkOnline } from './connectivity';
import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { BrandMark, Button, Dialog, Field } from '../components/ui';
import { api, json, reportPDF } from './api';
import type { Dossier, Organisation, Report, SignatureInput } from './api';
import { actions, pendingDraftCount, sync } from './outbox';
import type { Action } from './outbox';
import { ReportSignatures, SignaturesEditor } from './Signatures';
import { ReportContent } from './ReportContent';
import { PropertyFacts } from './Properties';
import s from './workspace.module.css';
import { errorText, kindLabel, dateLabel, announceRefresh, ErrorNotice } from './shared';
import { ReportDelivery } from './ReportDelivery';
import { Select } from './shared';
import { savePlatformFile, protectedURL } from './platform';

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
  const reportId = new URLSearchParams(useLocation().search).get('reportId') || '';
  const [report, setReport] = useState<Report>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [pdfBusy, setPDFBusy] = useState(false),
    [finaliseOpen, setFinaliseOpen] = useState(false),
    [signatures, setSignatures] = useState<SignatureInput[]>([]);

  const [draftCount, setDraftCount] = useState<number>();
  const [exception, setException] = useState(''),
    [exceptionNote, setExceptionNote] = useState(''),
    [disagreement, setDisagreement] = useState(''),
    [signingWarning, setSigningWarning] = useState('');
  const boundRevision = useRef(data.inspection.revision);
  useEffect(() => {
    if (boundRevision.current !== data.inspection.revision) {
      boundRevision.current = data.inspection.revision;
      setSignatures([]);
      setSigningWarning(
        'De dossierinhoud is gewijzigd. Controleer de nieuwste versie en verzamel de handtekeningen opnieuw.',
      );
    }
  }, [data.inspection.revision]);
  const modernSigning =
    data.format?.signingPolicy === 'resident_or_exception' ||
    !!data.inspection.correctsInspectionId ||
    !!data.inspection.latestReportId;
  const acknowledgement =
    data.format?.acknowledgement ||
    'Ondertekenaars bevestigen kennis te hebben genomen van de vastgelegde waarnemingen, afspraken en eventuele bezwaren.';

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
    let alive = true;
    setReport(undefined);
    if (data.inspection.status === 'final' || reportId)
      void api<Report>(
        `${path}/report${reportId ? `?reportId=${encodeURIComponent(reportId)}` : ''}`,
      )
        .then((value) => {
          if (alive) setReport(value);
        })
        .catch((e) => {
          if (alive) setError(errorText(e));
        });
    return () => {
      alive = false;
    };
  }, [data.inspection.status, path, reportId]);

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
      ? !unresolved &&
        !pending.length &&
        draftCount === 0 &&
        (!modernSigning || !!data.inspection.visitedAt)
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
          version: data.inspection.revision,
          signingException: exception ? { outcome: exception, note: exceptionNote } : null,
          disagreement,
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

      const { blob, filename } = await reportPDF(path, reportId || report?.id);

      await savePlatformFile(blob, filename);
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
          <h2>{report ? 'Definitief inspectierapport' : 'Conceptrapport'}</h2>

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
              (!!reportId && !report) ||
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

          {canWrite && !reportId && (
            <Button
              disabled={
                !ready ||
                !networkOnline() ||
                data.inspection.propertySnapshot?.linkState !== 'linked'
              }
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

      <ReportVersions
        path={path}
        scope={scope}
        inspection={data.inspection}
        editable={org.privileges.includes('inspections.write')}
      />
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
            Je legt deze rapportversie vast. Je kunt later binnen hetzelfde dossier verder bewerken;
            wijzigingen komen met auditlog in een nieuwe versie. Eerdere versies en handtekeningen
            blijven bewaard.
          </p>
          {modernSigning && <p>{acknowledgement}</p>}
          {signingWarning && <p className={s.warning}>{signingWarning}</p>}
          <SignaturesEditor
            value={signatures}
            onChange={setSignatures}
            disabled={busy}
            required={modernSigning}
          />
          {modernSigning && (
            <>
              <Select label="Bewoner ondertekent" value={exception} onChange={setException}>
                <option value="">Bewoner tekent</option>
                <option value="absent">Bewoner afwezig</option>
                <option value="refused">Bewoner weigert te tekenen</option>
                <option value="unable">Bewoner kan niet tekenen</option>
              </Select>
              {exception && (
                <Field
                  label="Reden niet ondertekenen"
                  value={exceptionNote}
                  onChange={(e) => setExceptionNote(e.target.value)}
                  required
                  maxLength={2000}
                />
              )}
              <Field
                label="Bezwaar of afwijkende verklaring bewoner (optioneel)"
                value={disagreement}
                onChange={(e) => setDisagreement(e.target.value)}
                maxLength={4000}
              />
            </>
          )}

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

      {report && (
        <a className={s.sourceLink} href={`/app/inspections/${data.inspection.id}/dossier`}>
          Naar Dossier
        </a>
      )}

      {!report && (
        <section className={s.stack} aria-label="Nog te doen">
          <h3>Voor het vastleggen</h3>
          <ul>
            {unresolved > 0 && (
              <li>
                <a href={`${location.pathname.replace(/\/report$/, '/review')}`}>
                  {unresolved} ruimtes of opnamen beoordelen
                </a>
              </li>
            )}
            {!!draftCount && <li>Lokale concepten bewaren of verwijderen</li>}
            {pending.length > 0 && <li>Wijzigingen synchroniseren</li>}
            {modernSigning && !data.inspection.visitedAt && (
              <li>Werkelijke bezoekdatum invullen bij Bezoek en planning</li>
            )}
            {data.inspection.propertySnapshot?.linkState !== 'linked' && (
              <li>Woningidentiteit bevestigen</li>
            )}
          </ul>
        </section>
      )}
      {report && (
        <ReportDelivery
          path={path}
          scope={scope}
          reportId={report.id}
          canWrite={org.privileges.includes('inspections.write') && !data.inspection.archivedAt}
        />
      )}
      <article
        className={s.report}
        aria-label="Inspectierapport"
        style={organisationTheme(report?.organisation?.tint || org.tint)}
      >
        <header>
          {report?.organisation?.logoAssetId ? (
            <img
              src={protectedURL(
                `/api/v1/orgs/${org.id}/norm-assets/${report.organisation.logoAssetId}`,
              )}
              alt={report.organisation.name}
              style={{ maxWidth: 180, maxHeight: 64, objectFit: 'contain' }}
            />
          ) : (
            <BrandMark size={28} />
          )}

          <strong>satvey.</strong>

          <span>{report ? 'Vastgelegd' : 'Concept'}</span>
        </header>

        <p className={s.eyebrow}>
          {report?.organisation?.name || org.name} · {kindLabel(data.inspection.kind)}
        </p>

        <h2>{report?.inspection.address || data.inspection.address}</h2>

        <p>
          {report?.inspection.postcode || data.inspection.postcode}{' '}
          {report?.inspection.city || data.inspection.city}
        </p>

        {report && <p className={s.muted}>Vastgelegd op {dateLabel(report.createdAt)}</p>}

        {report?.disagreement && (
          <section>
            <h3>Vastgelegd bezwaar</h3>
            <p>{report.disagreement}</p>
          </section>
        )}
        {report?.signingException && (
          <section>
            <h3>Bewoner heeft niet ondertekend</h3>
            <p>
              {{ absent: 'Afwezig', refused: 'Geweigerd', unable: 'Niet in staat' }[
                report.signingException.outcome
              ] || report.signingException.outcome}{' '}
              ? {report.signingException.note}
            </p>
          </section>
        )}
        <ReportContent data={report || data} org={org.id} />
        <details>
          <summary>Vastgoedobject en administratieve gegevens</summary>{' '}
          {(report?.inspection.propertySnapshot || data.inspection.propertySnapshot) && (
            <section>
              <h3>Vastgoedobject</h3>
              <PropertyFacts
                property={
                  (report?.inspection.propertySnapshot || data.inspection.propertySnapshot)!
                }
              />
            </section>
          )}
        </details>
        {report?.acknowledgement && <p>{report.acknowledgement}</p>}
        <ReportSignatures signatures={report?.signatures || []} />
      </article>
    </section>
  );
}
