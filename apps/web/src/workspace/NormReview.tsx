import { ScoreFields } from './Scoring';
import type { ScoreDetail } from './api';
import { protectedURL } from './platform';
import { useEffect, useState } from 'react';
import { Badge, Button, Dialog, Field } from '../components/ui';
import { api, json } from './api';
import type { Media, NormAssessment, NormDocument, NormOutcome } from './api';
import { draftGet, draftPut, draftRemove, enqueueEdit } from './outbox';
import type { Action } from './outbox';
import { outcomeLabels } from './labels';
import s from './workspace.module.css';

export function TranscriptEditor({
  media,
  path,
  scope,
  inspectionId,
  canWrite,
  pending,
  job,
}: {
  job?: { status: string; error: string };
  media: Media;
  path: string;
  scope: string;
  inspectionId: string;
  canWrite: boolean;
  pending: Action[];
}) {
  const key = `${scope}:inspectionDraft:${inspectionId}:transcript:${media.id}`,
    [text, setText] = useState(media.transcript || ''),
    [dirty, setDirty] = useState(false),
    [version, setVersion] = useState(media.transcriptVersion || 1),
    [error, setError] = useState(''),
    [skip, setSkip] = useState(false),
    [reason, setReason] = useState('');
  const endpoint = `${path}/media/${media.id}/transcript`,
    queued = pending.some((p) => p.path === endpoint);
  useEffect(() => {
    let alive = true;
    void draftGet<{ text: string; version: number }>(key).then((v) => {
      if (alive && v) {
        setText(v.text);
        setVersion(v.version);
        setDirty(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [key]);
  useEffect(() => {
    if (!dirty && !queued) {
      setText(media.transcript || '');
      setVersion(media.transcriptVersion || 1);
    }
  }, [media.transcript, media.transcriptVersion, dirty, queued]);
  return (
    <details className={s.transcript}>
      <summary>
        Uitgeschreven spraaknotitie{' '}
        {job?.status === 'pending' || job?.status === 'processing'
          ? '\u00b7 wordt uitgeschreven'
          : job?.status === 'failed'
            ? '\u00b7 aanvullen nodig'
            : media.transcript
              ? '\u00b7 beschikbaar'
              : ''}
      </summary>
      <p className={s.muted}>
        Controleer en verbeter de gesproken waarneming. De AI gebruikt deze tekst. Opslaan start een
        nieuwe analyse en vraagt herbevestiging van de betrokken beoordelingen.
      </p>
      {job?.status === 'failed' && (
        <p className={s.error} role="alert">
          {job.error}
        </p>
      )}
      {job && canWrite && !['done', 'skipped'].includes(job.status) && (
        <div className={s.actions}>
          {job.status === 'failed' && (
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                try {
                  await api(
                    `${path}/media/${media.id}/transcription`,
                    json('POST', { action: 'retry', reason: '' }),
                  );
                  window.dispatchEvent(new Event('satvey-refresh'));
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              Transcriptie opnieuw proberen
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setSkip(true)}>
            Zonder transcriptie verder
          </Button>
        </div>
      )}
      <Dialog
        open={skip}
        onOpenChange={setSkip}
        title="Zonder transcriptie verder"
        description="Vragen blijven open totdat je ze beantwoordt of expliciet afmeldt."
      >
        <form
          className={s.stack}
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api(
                `${path}/media/${media.id}/transcription`,
                json('POST', { action: 'skip', reason }),
              );
              setSkip(false);
              window.dispatchEvent(new Event('satvey-refresh'));
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          <Field
            label="Toelichting"
            required
            maxLength={3000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button type="submit">Handmatig verder</Button>
        </form>
      </Dialog>
      <label className={s.field}>
        <span>Uitgeschreven spraaknotitie</span>
        <textarea
          aria-label="Uitgeschreven spraaknotitie"
          rows={4}
          maxLength={20000}
          readOnly={!canWrite || queued}
          value={text}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            setDirty(true);
            void draftPut(key, { text: next, version, draft: true }).catch((e) =>
              setError(String(e)),
            );
          }}
        />
      </label>
      {canWrite && (
        <div className={s.actions}>
          <Button
            variant="secondary"
            disabled={!dirty || queued}
            onClick={async () => {
              try {
                await enqueueEdit(scope, inspectionId, endpoint, { transcript: text, version });
                await draftRemove(key);
                setDirty(false);
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            Tekst bewaren en analyseren
          </Button>
          {dirty && (
            <Button
              variant="ghost"
              onClick={() => {
                void draftRemove(key);
                setText(media.transcript || '');
                setVersion(media.transcriptVersion || 1);
                setDirty(false);
              }}
            >
              Concept verwerpen
            </Button>
          )}
        </div>
      )}
      {queued && (
        <p className={s.muted} role="status">
          Spraaknotitie wacht op synchronisatie
        </p>
      )}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
export function NormAssessmentReview({
  assessment: a,
  norms,
  path,
  scope,
  inspectionId,
  canWrite,
  processing,
  pending,
}: {
  assessment: NormAssessment;
  norms: NormDocument;
  path: string;
  scope: string;
  inspectionId: string;
  canWrite: boolean;
  processing: boolean;
  pending: Action[];
}) {
  const rule = norms.rules.find((r) => r.id === a.ruleId),
    endpoint = `${path}/assessments/${a.id}`,
    key = `${scope}:inspectionDraft:${inspectionId}:assessment:${a.id}`;
  const [scoreDetail, setScoreDetail] = useState<ScoreDetail | null | undefined>(a.scoreDetail),
    [outcome, setOutcome] = useState<NormOutcome>(
      a.reviewedOutcome || a.previousReviewedOutcome || a.outcome,
    ),
    [note, setNote] = useState(a.reviewNote || a.previousReviewNote || ''),
    [version, setVersion] = useState(a.version),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState('');
  const queued = pending.some((p) => p.path === endpoint);
  useEffect(() => {
    let alive = true;
    void draftGet<{
      outcome: NormOutcome;
      note: string;
      version: number;
      scoreDetail?: ScoreDetail | null;
    }>(key).then((v) => {
      if (alive && v) {
        setScoreDetail(v.scoreDetail);
        setOutcome(v.outcome);
        setNote(v.note);
        setVersion(v.version);
        setDirty(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [key]);
  useEffect(() => {
    if (!dirty && !queued) {
      setScoreDetail(a.scoreDetail);
      setOutcome(a.reviewedOutcome || a.previousReviewedOutcome || a.outcome);
      setNote(a.reviewNote || a.previousReviewNote || '');
      setVersion(a.version);
    }
  }, [
    a.version,
    a.scoreDetail,
    a.outcome,
    a.reviewedOutcome,
    a.reviewNote,
    a.previousReviewedOutcome,
    a.previousReviewNote,
    dirty,
    queued,
  ]);
  function saveDraft(nextOutcome: NormOutcome, nextNote: string) {
    const nextScore = ['not_assessable', 'not_applicable'].includes(nextOutcome)
      ? null
      : scoreDetail;
    setScoreDetail(nextScore);
    setOutcome(nextOutcome);
    setNote(nextNote);
    setDirty(true);
    void draftPut(key, {
      outcome: nextOutcome,
      note: nextNote,
      version,
      scoreDetail: nextScore,
      draft: true,
    }).catch((e) => setError(String(e)));
  }
  const noteRequired = outcome !== a.outcome || a.reason === 'Nog niet beoordeeld';
  const noteField = (
    <label className={s.field}>
      <span>Toelichting beoordeling</span>
      <textarea
        aria-label="Toelichting beoordeling"
        rows={2}
        maxLength={3000}
        required={noteRequired}
        readOnly={!canWrite || processing || a.stale || queued}
        value={note}
        onChange={(e) => saveDraft(outcome, e.target.value)}
      />
    </label>
  );
  return (
    <section className={s.normAssessment} aria-label={`Norm ${rule?.code || ''}`}>
      <div className={s.actions}>
        <strong>
          {rule?.code} · {rule?.title}
        </strong>
        <Badge tone={a.reviewedOutcome && !a.stale ? 'success' : 'warning'}>
          {a.stale ? 'Opnieuw beoordelen' : a.reviewedOutcome ? 'Bevestigd' : 'Te bevestigen'}
        </Badge>
      </div>
      <p className={s.muted}>{rule?.objectType}</p>
      {!a.reviewedOutcome && a.previousReviewedOutcome && (
        <p className={s.muted}>
          Je eerdere beoordeling is behouden als voorstel. Controleer deze opnieuw na de wijziging
          van de woninggegevens.
        </p>
      )}
      <details>
        <summary>Criteria en voorbeelden bekijken</summary>
        <p>
          <strong>Acceptabel:</strong> {rule?.acceptable}
        </p>
        <p>
          <strong>Niet acceptabel:</strong> {rule?.unacceptable}
        </p>
        {rule?.examples.map((ex) => (
          <p key={ex.id}>
            <Badge>{outcomeLabels[ex.outcome]}</Badge> {ex.caption}
            {ex.assetId && (
              <>
                {' '}
                ·{' '}
                <a
                  href={protectedURL(
                    `/api/v1${path.split('/inspections/')[0]}/norm-assets/${ex.assetId}`,
                  )}
                  target="_blank"
                  rel="noreferrer"
                >
                  Referentie openen
                </a>
              </>
            )}
          </p>
        ))}
      </details>
      <p>{a.reason}</p>
      <p className={s.muted}>
        {a.source === 'ai'
          ? 'AI-voorstel'
          : a.source === 'mock'
            ? 'Voorbeeldanalyse'
            : 'Bewijs nog te beoordelen'}{' '}
        · {outcomeLabels[a.outcome]}
      </p>
      {a.proposedScore != null && (
        <p className={s.muted}>
          Voorgestelde score: {a.proposedScore} · bevestig je eigen beoordeling.
        </p>
      )}
      {rule && (
        <ScoreFields
          org={path.split('/')[2]}
          rule={rule}
          value={scoreDetail}
          disabled={!canWrite || processing || queued || a.stale}
          onChange={(next, mapped) => {
            setScoreDetail(next);
            setDirty(true);
            if (mapped) setOutcome(mapped);
            void draftPut(key, {
              outcome: mapped || outcome,
              note,
              version,
              scoreDetail: next,
              draft: true,
            }).catch((e) => setError(String(e)));
          }}
        />
      )}
      <label className={s.field}>
        <span>Uitkomst kwaliteitsbeoordeling</span>
        <select
          aria-label="Uitkomst kwaliteitsbeoordeling"
          disabled={!canWrite || processing || a.stale || queued}
          value={outcome}
          onChange={(e) => saveDraft(e.target.value as NormOutcome, note)}
        >
          {Object.entries(outcomeLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {noteRequired ? (
        noteField
      ) : (
        <>
          {note && <p>{note}</p>}
          <details>
            <summary>
              {note ? 'Toelichting aanpassen' : 'Toelichting toevoegen (optioneel)'}
            </summary>
            {noteField}
          </details>
        </>
      )}
      {canWrite && (
        <div className={s.actions}>
          <Button
            size="sm"
            variant="secondary"
            disabled={
              processing ||
              a.stale ||
              queued ||
              (noteRequired && !note.trim()) ||
              (!!a.reviewedOutcome && !dirty)
            }
            onClick={async () => {
              try {
                await enqueueEdit(scope, inspectionId, endpoint, {
                  outcome,
                  note,
                  version,
                  scoreDetail,
                });
                await draftRemove(key);
                setDirty(false);
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            Beoordeling bevestigen
          </Button>
          {dirty && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void draftRemove(key);
                setScoreDetail(a.scoreDetail);
                setOutcome(a.reviewedOutcome || a.outcome);
                setNote(a.reviewNote);
                setVersion(a.version);
                setDirty(false);
              }}
            >
              Concept verwerpen
            </Button>
          )}
        </div>
      )}
      {queued && (
        <p className={s.muted} role="status">
          Beoordeling wacht op synchronisatie
        </p>
      )}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
