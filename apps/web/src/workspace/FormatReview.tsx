import { ScoreFields, ScoreSummary } from './Scoring';
import { EvidenceThumbnail } from './EvidenceThumbnail';
import { protectedURL } from './platform';
import { PhotoTile } from './PhotoViewer';
import { useEffect, useMemo, useEffectEvent, useState } from 'react';
import { CheckCheck, Mic, X } from 'lucide-react';
import { Badge, Button, Dialog, Field } from '../components/ui';
import { api, json, mediaURL } from './api';
import type { Dossier, FormatAnswer, FormatQuestion, FormatScope, Room } from './api';
import {
  actions,
  draftGet,
  draftPut,
  draftRemove,
  enqueueEdit,
  removeAction,
  pendingDraftCount,
  sync,
} from './outbox';
import type { Action } from './outbox';
import { FormatSelect, evidenceLabels } from './formatFields';
import { outcomeLabels } from './labels';
import s from './workspace.module.css';
import f from './formats.module.css';

const refresh = () => window.dispatchEvent(new Event('satvey-refresh'));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export function scopeForRoom(data: Dossier, roomId: string) {
  const room = data.rooms.find((r) => r.id === roomId);
  return data.format?.scopes.find((c) => c.id === room?.categoryId);
}
function active(q: FormatQuestion, category: FormatScope, answers: FormatAnswer[]): boolean {
  if (!q.condition) return true;
  const p = answers.find((a) => a.questionId === q.condition?.questionId),
    parent = category.questions.find((v) => v.id === q.condition?.questionId);
  if (parent && !active(parent, category, answers)) return false;
  return !p || p.status !== 'confirmed' || String(p.value) === q.condition.equals;
}
export function answerText(a?: FormatAnswer) {
  if (!a || a.status === 'missing' || a.value === null)
    return a?.status === 'unanswerable' ? 'Niet te beantwoorden' : 'Nog niet beantwoord';
  if (a.status === 'unanswerable') return 'Niet te beantwoorden';
  if (typeof a.value === 'boolean') return a.value ? 'Ja' : 'Nee';
  if (typeof a.value === 'string' && a.value in outcomeLabels)
    return outcomeLabels[a.value as keyof typeof outcomeLabels];
  return String(a.value);
}
function gap(q: FormatQuestion, a?: FormatAnswer) {
  if (!a || a.status === 'missing' || a.value === null) return a?.status !== 'unanswerable';
  if (a.status === 'unanswerable') return false;
  if (
    (q.evidence === 'photo' || q.evidence === 'photo_statement') &&
    a.photoIds.length < Math.max(1, q.minPhotos)
  )
    return true;
  if (q.ruleId && (!a.outcome || a.outcome === 'not_assessable' || a.outcome === 'not_applicable'))
    return true;
  if (
    (q.evidence === 'statement' || q.evidence === 'photo_statement') &&
    !a.audioIds.length &&
    !a.reason.trim() &&
    !(['text', 'evidence'].includes(q.kind) && typeof a.value === 'string' && a.value.trim())
  )
    return true;
  return false;
}
function QuickChoices({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className={f.quickChoices}>
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          variant={value === option.value ? 'primary' : 'secondary'}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
export function TalkingGuide({
  data,
  roomId,
  recording,
}: {
  data: Dossier;
  roomId: string;
  recording: boolean;
}) {
  const [frozen, setFrozen] = useState<FormatQuestion[]>([]),
    [dismissed, setDismissed] = useState<string[]>([]);
  const category = scopeForRoom(data, roomId),
    answers = (data.answers || []).filter((a) => a.roomId === roomId);
  const questions = (category?.questions || []).filter((q) => active(q, category!, answers));
  const candidates = useMemo(() => {
    const category = scopeForRoom(data, roomId);
    if (!category) return [];
    const answers = (data.answers || []).filter((a) => a.roomId === roomId);
    return category.questions
      .filter(
        (q) =>
          active(q, category, answers) &&
          gap(
            q,
            answers.find((a) => a.questionId === q.id),
          ),
      )
      .sort((a, b) => Number(b.required) - Number(a.required));
  }, [data, roomId]);
  useEffect(() => {
    if (!recording) setFrozen(candidates);
  }, [recording, candidates]);
  if (!category || !questions.length) return null;
  const visible = frozen.filter((q) => !dismissed.includes(q.id)),
    job = data.scopeJobs?.find((j) => j.roomId === roomId),
    batchIds = data.batches
      .filter((b) => b.roomId === roomId && b.status !== 'excluded')
      .map((b) => b.id),
    audioIds = data.media
      .filter((m) => batchIds.includes(m.batchId) && m.kind === 'audio')
      .map((m) => m.id);
  const transcribing = data.transcriptionJobs?.some(
    (j) => audioIds.includes(j.mediaId) && (j.status === 'pending' || j.status === 'processing'),
  );
  return (
    <aside className={f.guide} aria-label="Spreekhulp">
      <h3>
        <Mic size={17} />
        Bespreek deze punten
      </h3>
      <ol>
        {visible.slice(0, 3).map((q) => (
          <li key={q.id}>
            <div>
              <strong>
                {q.talkingPrompt || q.instruction || `Beschrijf: ${q.title.toLowerCase()}`}
              </strong>
              <p>
                {evidenceLabels[q.evidence]}
                {q.required ? ' · verplicht' : ''}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Spreekhulp overslaan: ${q.title}`}
              disabled={recording}
              onClick={() => setDismissed([...dismissed, q.id])}
            >
              <X size={15} />
            </Button>
          </li>
        ))}
      </ol>
      {!visible.length && (
        <p>
          {candidates.length
            ? 'Onderwerpen tijdelijk verborgen. Vragen blijven openstaan.'
            : 'De antwoorden lijken ingevuld. Controleer en bevestig de bevindingen en ruimtesamenvatting.'}
        </p>
      )}
      {visible.length > 3 && (
        <details>
          <summary>Meer gesprekspunten ({visible.length - 3})</summary>
          <ol>
            {visible.slice(3).map((q) => (
              <li key={q.id}>{q.talkingPrompt || q.instruction || q.title}</li>
            ))}
          </ol>
        </details>
      )}
      {dismissed.length > 0 && (
        <Button variant="ghost" size="sm" disabled={recording} onClick={() => setDismissed([])}>
          Verborgen gesprekspunten tonen
        </Button>
      )}
      <p role="status">
        {recording
          ? 'Spreek in je eigen woorden. De spreekhulp wordt na verwerking bijgewerkt.'
          : transcribing
            ? 'Audio wordt uitgeschreven. De gesprekspunten worden daarna bijgewerkt.'
            : job && job.status !== 'done'
              ? 'De opnamen worden verwerkt; nog geen nieuwe samenvatting.'
              : `${
                  questions.filter(
                    (q) =>
                      !gap(
                        q,
                        answers.find((a) => a.questionId === q.id),
                      ),
                  ).length
                } van ${questions.length} vragen ingevuld of afgemeld · controle blijft nodig`}
      </p>
    </aside>
  );
}
export function FormatRoomReview({
  data,
  room,
  path,
  scope,
  org,
  pending,
  canWrite,
}: {
  data: Dossier;
  room: Room;
  path: string;
  scope: string;
  org: string;
  pending: Action[];
  canWrite: boolean;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [exception, setException] = useState(false),
    [reason, setReason] = useState(''),
    [analysisAction, setAnalysisAction] = useState(false),
    [manualReason, setManualReason] = useState(''),
    [drafts, setDrafts] = useState(0),
    [openAnswers, setOpenAnswers] = useState<string[]>([]);
  const category = scopeForRoom(data, room.id),
    answers = (data.answers || []).filter((a) => a.roomId === room.id),
    job = data.scopeJobs?.find((j) => j.roomId === room.id),
    approved = room.approvedGeneration === room.generation;
  useEffect(() => {
    const update = () =>
      void pendingDraftCount(
        scope,
        data.inspection.id,
        data.observations.map((o) => o.id),
      )
        .then(setDrafts)
        .catch(() => setDrafts(1));
    update();
    window.addEventListener('satvey-drafts', update);
    return () => window.removeEventListener('satvey-drafts', update);
  }, [scope, data.inspection.id, data.observations]);
  if (!category) return null;
  const questions = category.questions.filter((q) => active(q, category, answers)),
    missing = questions.filter(
      (q) =>
        q.required &&
        gap(
          q,
          answers.find((a) => a.questionId === q.id),
        ),
    ).length;
  const batches = data.batches.filter((b) => b.roomId === room.id && b.status !== 'excluded'),
    sourceBatches = category.property
      ? data.batches.filter((b) => b.status !== 'excluded')
      : batches;
  const audioIds = data.media
      .filter((m) => sourceBatches.some((b) => b.id === m.batchId) && m.kind === 'audio')
      .map((m) => m.id),
    audioPending = data.transcriptionJobs?.some(
      (j) => audioIds.includes(j.mediaId) && !['done', 'skipped'].includes(j.status),
    );
  const observations = data.observations.filter((o) => batches.some((b) => b.id === o.batchId)),
    processing = !!audioPending || (!!job && job.status !== 'done');
  async function approve(waiver = '') {
    setError('');
    setBusy(true);
    try {
      if (
        await pendingDraftCount(
          scope,
          data.inspection.id,
          data.observations.map((o) => o.id),
        )
      )
        throw new Error('Bewaar of verwijder eerst je lokale concepten.');
      await sync(scope);
      if ((await actions(scope)).some((a) => a.inspectionId === data.inspection.id))
        throw new Error('Synchroniseer eerst de wijzigingen op dit apparaat.');
      await api(
        `${path}/rooms/${room.id}/approval`,
        json('PUT', {
          generation: room.generation,
          versions: Object.fromEntries(answers.map((a) => [a.id, a.version])),
          observationVersions: Object.fromEntries(observations.map((o) => [o.id, o.version])),
          exception: waiver,
        }),
      );
      setException(false);
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={f.summary} aria-label="Ruimtesamenvatting">
      <div className={f.summaryHeader}>
        <h3>Ruimtesamenvatting</h3>
        <Badge tone={approved ? 'success' : missing ? 'warning' : 'neutral'}>
          {approved
            ? 'Goedgekeurd'
            : missing
              ? `${missing} verplicht punt open`
              : 'Klaar om te controleren'}
        </Badge>
      </div>
      {processing && (
        <p role="status" className={s.muted}>
          {audioPending ? 'Wachten op transcriptie.' : 'Analyse wordt verwerkt.'}
        </p>
      )}
      {job?.error && (
        <p role="alert" className={s.error}>
          {job.error}
        </p>
      )}
      {job && job.status !== 'done' && canWrite && (
        <div className={s.actions}>
          {job.status === 'failed' && (
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                try {
                  await api(
                    `${path}/rooms/${room.id}/analysis`,
                    json('POST', { action: 'retry', reason: '' }),
                  );
                  refresh();
                } catch (e) {
                  setError(message(e));
                }
              }}
            >
              Analyse opnieuw proberen
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setAnalysisAction(true)}>
            Handmatig verder
          </Button>
        </div>
      )}
      {questions.map((q) => {
        const answer = answers.find((a) => a.questionId === q.id);
        if (!answer) return null;
        return (
          <details
            key={q.id}
            className={f.answerRow}
            onToggle={(e) => {
              const open = e.currentTarget.open;
              setOpenAnswers((ids) =>
                open
                  ? ids.includes(q.id)
                    ? ids
                    : [...ids, q.id]
                  : ids.filter((id) => id !== q.id),
              );
            }}
          >
            <summary>
              <div>
                <strong>{q.title}</strong>
                <p>
                  {answerText(answer)}
                  {q.unit && answer.value !== null ? ` ${q.unit}` : ''}
                </p>
                <ScoreSummary value={answer.scoreDetail} />
                {answer.status === 'unanswerable' && <p>{answer.reason}</p>}
                <div className={f.sources}>
                  {answer.photoIds.map((id) => (
                    <a
                      href={mediaURL(org, id)}
                      key={id}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <EvidenceThumbnail
                        org={org}
                        id={id}
                        name={data.media.find((m) => m.id === id)?.name || 'Bronfoto'}
                      />
                    </a>
                  ))}
                  {answer.audioIds.length > 0 && <span>Bron: spraaknotitie</span>}
                </div>
              </div>
              <Badge
                tone={
                  answer.status === 'unanswerable'
                    ? 'warning'
                    : gap(q, answer)
                      ? 'warning'
                      : answer.status === 'confirmed'
                        ? 'success'
                        : 'ai'
                }
              >
                {answer.status === 'unanswerable'
                  ? 'Afgemeld'
                  : gap(q, answer)
                    ? 'Aanvullen'
                    : answer.status === 'confirmed'
                      ? 'Bevestigd'
                      : answer.human
                        ? 'Hercontroleren'
                        : 'Voorstel'}
              </Badge>
            </summary>
            {openAnswers.includes(q.id) && (
              <AnswerEditor
                key={answer.id}
                question={q}
                answer={answer}
                data={data}
                category={category}
                path={path}
                scope={scope}
                org={org}
                canWrite={canWrite}
                pending={pending}
              />
            )}
          </details>
        );
      })}
      {!questions.length && (
        <p>Geen verplichte vragen voor deze ruimte. Controleer eventuele opnamen en bevindingen.</p>
      )}
      {canWrite && (
        <>
          <div className={f.footer}>
            <p className={s.muted}>
              {observations.filter((o) => o.status === 'draft').length > 0
                ? `${observations.filter((o) => o.status === 'draft').length} bevindingen nog te beoordelen. Kies hierboven Goedkeuren of Afwijzen.`
                : 'Controleer antwoorden en bronbewijs.'}
            </p>
            <Button
              icon={<CheckCheck size={17} />}
              loading={busy}
              disabled={
                approved ||
                processing ||
                missing > 0 ||
                pending.length > 0 ||
                drafts > 0 ||
                observations.some((o) => o.status === 'draft')
              }
              onClick={() => void approve()}
            >
              Beoordeling bevestigen
            </Button>
          </div>
          <details className={f.exception}>
            <summary>Ruimte niet aanwezig of niet toegankelijk</summary>
            <p>
              Alle vragen en vervolgvragen in deze ruimte worden met jouw toelichting afgemeld.
              Opnamen in deze ruimte worden uitgesloten.
            </p>
            <Button variant="secondary" size="sm" onClick={() => setException(true)}>
              Ruimte afmelden
            </Button>
          </details>
        </>
      )}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      <Dialog
        open={exception}
        onOpenChange={setException}
        title="Ruimte afmelden"
        description="Deze toelichting wordt vastgelegd bij alle vragen in de ruimte."
      >
        <form
          className={s.stack}
          onSubmit={(e) => {
            e.preventDefault();
            void approve(reason);
          }}
        >
          <Field
            label="Reden (niet aanwezig of niet toegankelijk)"
            required
            maxLength={3000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            type="submit"
            loading={busy}
            disabled={!reason.trim() || pending.length > 0 || drafts > 0}
          >
            Alle vragen met reden afmelden
          </Button>
        </form>
      </Dialog>
      <Dialog
        open={analysisAction}
        onOpenChange={setAnalysisAction}
        title="Handmatig verder"
        description="De AI-analyse stopt. Vul ontbrekende antwoorden in of meld ze expliciet af."
      >
        <form
          className={s.stack}
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api(
                `${path}/rooms/${room.id}/analysis`,
                json('POST', { action: 'skip', reason: manualReason }),
              );
              setAnalysisAction(false);
              refresh();
            } catch (e) {
              setError(message(e));
            }
          }}
        >
          <Field
            label="Toelichting"
            required
            value={manualReason}
            onChange={(e) => setManualReason(e.target.value)}
          />
          <Button type="submit">Handmatig beoordelen</Button>
        </form>
      </Dialog>
    </section>
  );
}
function AnswerEditor({
  question: q,
  answer: initial,
  data,
  category,
  path,
  scope,
  org,
  canWrite,
  pending,
}: {
  question: FormatQuestion;
  answer: FormatAnswer;
  data: Dossier;
  category: FormatScope;
  path: string;
  scope: string;
  org: string;
  canWrite: boolean;
  pending: Action[];
}) {
  const key = `${scope}:inspectionDraft:${data.inspection.id}:answer:${initial.id}`,
    [draft, setDraft] = useState(initial),
    [dirty, setDirty] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [latest, setLatest] = useState<FormatAnswer>(),
    [regularReason, setRegularReason] = useState(
      initial.status === 'unanswerable' ? '' : initial.reason,
    );
  const endpoint = `${path}/answers/${initial.id}`,
    queuedAction = pending.find((p) => p.path === endpoint),
    queued = !!queuedAction;
  const queuedPayload = useEffectEvent(() => queuedAction?.payload);
  useEffect(() => {
    let alive = true;
    void draftGet<FormatAnswer>(key)
      .then((saved) => {
        if (alive) {
          if (saved) {
            setDraft(saved);
            setDirty(true);
          } else {
            const payload = queuedPayload();
            if (payload) setDraft(payload as unknown as FormatAnswer);
          }
          setReady(true);
        }
      })
      .catch((e) => setError(message(e)));
    return () => {
      alive = false;
    };
  }, [key]);
  useEffect(() => {
    // Keep the editor and comparison dialog mounted across polling updates. Only replace a
    // clean, acknowledged value; in-progress edits retain their original concurrency version.
    if (!dirty && !queued && initial.version > draft.version) setDraft(initial);
  }, [initial, dirty, queued, draft.version]);
  const eligibleBatches = data.batches.filter(
      (b) => b.status !== 'excluded' && (category.property || b.roomId === initial.roomId),
    ),
    media = data.media.filter((m) => eligibleBatches.some((b) => b.id === m.batchId)),
    rule = data.norms?.rules.find((r) => r.id === q.ruleId);
  const writtenAnswer = ['text', 'evidence'].includes(q.kind),
    photoMissing =
      ['photo', 'photo_statement'].includes(q.evidence) &&
      draft.photoIds.length < Math.max(1, q.minPhotos);
  const reasonRequired =
    draft.status === 'unanswerable' ||
    (!writtenAnswer &&
      ((['statement', 'photo_statement'].includes(q.evidence) && !draft.audioIds.length) ||
        ((q.evidence === 'any' || !!q.ruleId) &&
          !draft.photoIds.length &&
          !draft.audioIds.length)));
  function patch(v: Partial<FormatAnswer>) {
    const next = { ...draft, ...v };
    if (
      next.status === 'unanswerable' ||
      ['not_assessable', 'not_applicable'].includes(next.outcome)
    )
      next.scoreDetail = null;
    setDraft(next);
    setDirty(true);
    void draftPut(key, next).catch((e) => setError(message(e)));
  }
  async function save() {
    try {
      await enqueueEdit(scope, data.inspection.id, endpoint, {
        ...draft,
        status: draft.status === 'unanswerable' ? 'unanswerable' : 'confirmed',
      });
      await draftRemove(key);
      setDirty(false);
    } catch (e) {
      setError(message(e));
    }
  }
  async function resolve(useLocal: boolean) {
    if (!latest || !queuedAction) return;
    try {
      if (useLocal) {
        const next = { ...draft, version: latest.version };
        await draftPut(key, next);
        await removeAction(queuedAction.id);
        setDraft(next);
        setDirty(true);
      } else {
        await draftRemove(key);
        await removeAction(queuedAction.id);
        setDraft(latest);
        setDirty(false);
      }
      setLatest(undefined);
      refresh();
    } catch (e) {
      setError(message(e));
    }
  }
  return (
    <div className={f.answerBody}>
      {q.instruction && <p>{q.instruction}</p>}
      {draft.proposedScore != null && (
        <p className={s.muted}>
          Voorgestelde score: {draft.proposedScore} · controle blijft nodig.
        </p>
      )}
      {rule && draft.status !== 'unanswerable' && (
        <ScoreFields
          org={org}
          rule={rule}
          value={draft.scoreDetail}
          disabled={!canWrite || queued}
          onChange={(scoreDetail, mapped) =>
            patch({
              scoreDetail,
              ...(mapped
                ? { outcome: mapped, ...(q.kind === 'quality' ? { value: mapped } : {}) }
                : {}),
            })
          }
        />
      )}
      {rule && (
        <details className={f.reference}>
          <summary>Normcriteria en voorbeelden</summary>
          <p>
            <strong>Acceptabel:</strong> {rule.acceptable}
          </p>
          <p>
            <strong>Niet acceptabel:</strong> {rule.unacceptable}
          </p>
          {rule.examples.map((ex) => (
            <figure key={ex.id}>
              {ex.assetId && (
                <img
                  alt={ex.caption}
                  src={protectedURL(`/api/v1/orgs/${org}/norm-assets/${ex.assetId}`)}
                />
              )}
              <figcaption>{ex.caption}</figcaption>
            </figure>
          ))}
        </details>
      )}
      <fieldset className={f.settings} disabled={!canWrite || queued || !ready}>
        {draft.status !== 'unanswerable' && (
          <>
            {q.kind === 'boolean' ? (
              <QuickChoices
                label="Antwoord"
                value={draft.value === null ? '' : String(draft.value)}
                options={[
                  { value: 'true', label: 'Ja' },
                  { value: 'false', label: 'Nee' },
                ]}
                onChange={(v) => patch({ value: v === 'true' })}
              />
            ) : q.kind === 'choice' && q.choices.length <= 4 ? (
              <QuickChoices
                label="Antwoord"
                value={String(draft.value ?? '')}
                options={q.choices.map((value) => ({ value, label: value }))}
                onChange={(value) => patch({ value })}
              />
            ) : q.kind === 'choice' ? (
              <FormatSelect
                label="Antwoord"
                value={String(draft.value ?? '')}
                onChange={(v) => patch({ value: v || null })}
              >
                <option value="">Kies een antwoord</option>
                {q.choices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </FormatSelect>
            ) : q.kind === 'quality' ? (
              <QuickChoices
                label="Kwaliteitsbeoordeling"
                value={draft.outcome || String(draft.value || '')}
                options={[
                  { value: 'acceptable', label: 'Acceptabel' },
                  { value: 'unacceptable', label: 'Niet acceptabel' },
                ]}
                onChange={(v) => patch({ value: v, outcome: v as FormatAnswer['outcome'] })}
              />
            ) : q.kind === 'number' ? (
              <Field
                label={`Antwoord${q.unit ? ` (${q.unit})` : ''}`}
                type="number"
                step="any"
                value={String(draft.value ?? '')}
                onChange={(e) =>
                  patch({ value: e.target.value === '' ? null : Number(e.target.value) })
                }
              />
            ) : (
              <label className={s.field}>
                <span>Antwoord</span>
                <textarea
                  aria-label="Antwoord"
                  rows={3}
                  maxLength={10000}
                  value={String(draft.value ?? '')}
                  onChange={(e) => patch({ value: e.target.value || null })}
                />
              </label>
            )}
            {q.ruleId && q.kind !== 'quality' && (
              <QuickChoices
                label="Gekoppeld normoordeel"
                value={draft.outcome}
                options={[
                  { value: 'acceptable', label: 'Acceptabel' },
                  { value: 'unacceptable', label: 'Niet acceptabel' },
                ]}
                onChange={(v) => patch({ outcome: v as FormatAnswer['outcome'] })}
              />
            )}
            <p className={s.muted}>
              {evidenceLabels[q.evidence]}
              {['photo', 'photo_statement'].includes(q.evidence)
                ? ` · minimaal ${Math.max(1, q.minPhotos)} foto('s)`
                : ''}
            </p>
            {!!media.length && (
              <details open={photoMissing || undefined}>
                <summary>
                  {draft.photoIds.length} foto's en {draft.audioIds.length} spraaknotities gekoppeld
                  - bronnen aanpassen
                </summary>
                <div className={f.answerBody}>
                  {media.some((m) => m.kind === 'photo') && (
                    <div className={f.sourcePhotos} aria-label="Bronfoto's kiezen">
                      {media
                        .filter((m) => m.kind === 'photo')
                        .map((m, i) => (
                          <button
                            type="button"
                            key={m.id}
                            aria-label={`Bronfoto ${i + 1}: ${m.name}`}
                            aria-pressed={draft.photoIds.includes(m.id)}
                            onClick={() =>
                              patch({
                                photoIds: draft.photoIds.includes(m.id)
                                  ? draft.photoIds.filter((v) => v !== m.id)
                                  : [...draft.photoIds, m.id],
                              })
                            }
                          >
                            <img src={mediaURL(org, m.id)} alt={m.name} />
                          </button>
                        ))}
                    </div>
                  )}
                  {media
                    .filter((m) => m.kind === 'audio' && m.transcript)
                    .map((m, i) => (
                      <Button
                        key={m.id}
                        type="button"
                        size="sm"
                        variant="secondary"
                        aria-pressed={draft.audioIds.includes(m.id)}
                        onClick={() =>
                          patch({
                            audioIds: draft.audioIds.includes(m.id)
                              ? draft.audioIds.filter((v) => v !== m.id)
                              : [...draft.audioIds, m.id],
                          })
                        }
                      >
                        {draft.audioIds.includes(m.id) ? 'Gekoppeld: ' : 'Koppel '}spraaknotitie{' '}
                        {i + 1}
                      </Button>
                    ))}
                </div>
              </details>
            )}
          </>
        )}
        {reasonRequired ? (
          <label className={s.field}>
            <span>
              {draft.status === 'unanswerable'
                ? 'Waarom niet te beantwoorden?'
                : 'Onderbouwing of geschreven waarneming'}
            </span>
            <textarea
              aria-label={
                draft.status === 'unanswerable'
                  ? 'Waarom niet te beantwoorden?'
                  : 'Onderbouwing of geschreven waarneming'
              }
              rows={3}
              maxLength={3000}
              required={reasonRequired}
              value={draft.reason}
              onChange={(e) => patch({ reason: e.target.value })}
            />
          </label>
        ) : (
          <>
            {draft.reason && <p className={s.description}>{draft.reason}</p>}
            <details>
              <summary>
                {draft.reason ? 'Toelichting aanpassen' : 'Toelichting toevoegen (optioneel)'}
              </summary>
              <label className={s.field}>
                <span>
                  {draft.status === 'unanswerable'
                    ? 'Waarom niet te beantwoorden?'
                    : 'Onderbouwing of geschreven waarneming'}
                </span>
                <textarea
                  aria-label={
                    draft.status === 'unanswerable'
                      ? 'Waarom niet te beantwoorden?'
                      : 'Onderbouwing of geschreven waarneming'
                  }
                  rows={3}
                  maxLength={3000}
                  required={reasonRequired}
                  value={draft.reason}
                  onChange={(e) => patch({ reason: e.target.value })}
                />
              </label>
            </details>
          </>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            if (draft.status === 'unanswerable')
              patch({ status: 'suggested', reason: regularReason });
            else {
              setRegularReason(draft.reason);
              patch({ status: 'unanswerable', reason: '' });
            }
          }}
        >
          {draft.status === 'unanswerable' ? 'Toch beantwoorden' : 'Niet te beantwoorden'}
        </Button>
        {draft.status === 'unanswerable' && (
          <p className={s.muted}>
            Deze toelichting geldt ook voor eventuele afhankelijke vervolgvragen.
          </p>
        )}
        {canWrite && (
          <div className={s.actions}>
            <Button size="sm" onClick={() => void save()} disabled={!dirty}>
              Antwoord bewaren
            </Button>
            {dirty && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void draftRemove(key);
                  setDraft(initial);
                  setDirty(false);
                }}
              >
                Wijziging verwerpen
              </Button>
            )}
          </div>
        )}
      </fieldset>
      {queued && <p role="status">Antwoord wacht op synchronisatie.</p>}
      {queuedAction?.error && (
        <div>
          <p className={s.error} role="alert">
            {queuedAction.error} Je lokale antwoord blijft bewaard. Bekijk de
            synchronisatieproblemen bovenaan.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              try {
                const current = await api<Dossier>(path);
                const answer = current.answers?.find((a) => a.id === initial.id);
                if (!answer) throw new Error('Antwoord niet meer beschikbaar');
                setLatest(answer);
              } catch (e) {
                setError(message(e));
              }
            }}
          >
            Vergelijk met server
          </Button>
        </div>
      )}
      <Dialog
        open={!!latest}
        onOpenChange={(open) => {
          if (!open) setLatest(undefined);
        }}
        title="Antwoord vergelijken"
        description="Bekijk beide antwoorden voordat je verdergaat. Controleer ook de bronnen wanneer opnamen of transcripties zijn gewijzigd."
      >
        <div className={s.stack}>
          <div>
            <strong>Op de server</strong>
            <p>{answerText(latest)}</p>
            <p>{latest?.reason}</p>
          </div>
          <div>
            <strong>Jouw lokale antwoord</strong>
            <p>{answerText(draft)}</p>
            <p>{draft.reason}</p>
          </div>
          <div className={s.actions}>
            <Button variant="secondary" onClick={() => void resolve(false)}>
              Serverantwoord gebruiken
            </Button>
            <Button onClick={() => void resolve(true)}>Mijn antwoord verder bewerken</Button>
          </div>
        </div>
      </Dialog>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function FormatReportResults({
  data,
  org,
  editing,
  showPhotos = true,
}: {
  data: Pick<Dossier, 'format' | 'answers' | 'rooms'> & Partial<Pick<Dossier, 'media'>>;
  org?: string;
  editing?: { scope: string; path: string; inspectionId: string };
  showPhotos?: boolean;
}) {
  if (!data.format) return null;
  return (
    <section className={f.coverage}>
      <h3>
        {data.format.name} · versie {data.format.number}
      </h3>
      {data.rooms.map((room) => {
        const category = data.format!.scopes.find((c) => c.id === room.categoryId),
          answers = (data.answers || []).filter((a) => a.roomId === room.id);
        if (!category) return null;
        if (room.approvedGeneration !== room.generation)
          return (
            <div key={room.id}>
              <h4>{room.name}</h4>
              <p>Nog niet beoordeeld</p>
            </div>
          );
        return (
          <div key={room.id}>
            <h4>{room.name}</h4>
            {category.questions
              .filter((q) => active(q, category, answers))
              .map((q) => {
                const a = answers.find((a) => a.questionId === q.id);
                return (
                  <p key={q.id}>
                    <strong>{q.title}:</strong> {answerText(a)}
                    {q.unit && a?.value !== null ? ` ${q.unit}` : ''}
                    {a?.reason && ['confirmed', 'unanswerable'].includes(a.status)
                      ? ` — ${a.reason}`
                      : ''}
                  </p>
                );
              })}
            {org && showPhotos && (
              <div className={s.gallery}>
                {(data.media || [])
                  .filter(
                    (m) => m.kind === 'photo' && answers.some((a) => a.photoIds.includes(m.id)),
                  )
                  .map((m) => (
                    <PhotoTile key={m.id} media={m} org={org} editing={editing} />
                  ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
