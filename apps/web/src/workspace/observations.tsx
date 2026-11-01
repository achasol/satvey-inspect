import { useEffect, useRef, useState } from 'react';
import { Check, CheckCheck, Plus } from 'lucide-react';
import { Badge, Button, Field } from '../components/ui';
import { api, json, uuid } from './api';
import type { Batch, Dossier, Observation, Organisation } from './api';
import { draftGet, draftPut, draftRemove, enqueueEdit } from './outbox';
import type { Action } from './outbox';
import { TranscriptEditor, NormAssessmentReview } from './NormReview';
import s from './workspace.module.css';
import { errorText, announceRefresh, ErrorNotice } from './shared';
import { Gallery } from './capture';

export function BatchCard({
  batch,

  data,

  org,

  scope,

  path,

  canWrite,

  review,

  pending,
}: {
  batch: Batch;

  data: Dossier;

  org: Organisation;

  scope: string;

  path: string;

  canWrite: boolean;

  review: boolean;

  pending: Action[];
}) {
  const [error, setError] = useState('');

  const observations = data.observations.filter((o) => o.batchId === batch.id),
    processing = data.jobs.some((j) => j.batchId === batch.id && j.status !== 'done'),
    queued = pending.some(
      (p) => p.path.includes(batch.id) || observations.some((o) => p.path.endsWith(o.id)),
    );

  const analysisJob = data.jobs.find((j) => j.batchId === batch.id);

  async function analysisAction(action: 'retry' | 'skip') {
    try {
      await api(`${path}/batches/${batch.id}/analysis`, json('POST', { action }));

      announceRefresh();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function mark(status: string) {
    setError('');

    try {
      await enqueueEdit(scope, data.inspection.id, `${path}/batches/${batch.id}`, {
        status,

        version: batch.version,
      });
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <article className={s.batch}>
      <header className={s.batchHeader}>
        <span>
          {new Date(batch.createdAt).toLocaleTimeString('nl-NL', {
            hour: '2-digit',

            minute: '2-digit',
          })}
        </span>

        <Badge
          tone={
            batch.status === 'reviewed'
              ? 'success'
              : batch.status === 'excluded'
                ? 'neutral'
                : 'warning'
          }
        >
          {batch.status === 'reviewed'
            ? 'Beoordeeld'
            : batch.status === 'excluded'
              ? 'Uitgesloten'
              : 'Te beoordelen'}
        </Badge>
      </header>

      <Gallery
        media={data.media.filter((m) => m.batchId === batch.id)}
        org={org.id}
        editing={canWrite ? { scope, path, inspectionId: data.inspection.id } : undefined}
      />

      {data.media

        .filter((m) => m.batchId === batch.id && m.kind === 'audio')

        .map((m) => (
          <TranscriptEditor
            key={m.id}
            media={m}
            path={path}
            scope={scope}
            inspectionId={data.inspection.id}
            canWrite={canWrite}
            pending={pending}
            job={data.transcriptionJobs?.find((j) => j.mediaId === m.id)}
          />
        ))}

      {review &&
        batch.status !== 'excluded' &&
        data.norms &&
        (data.assessments || [])

          .filter((a) => a.batchId === batch.id)

          .map((a) => (
            <NormAssessmentReview
              key={a.id}
              assessment={a}
              norms={data.norms!}
              path={path}
              scope={scope}
              inspectionId={data.inspection.id}
              canWrite={canWrite}
              processing={processing}
              pending={pending}
            />
          ))}

      {processing && analysisJob?.status !== 'failed' && (
        <p role="status" className={s.muted}>
          Analyse verwerken…
        </p>
      )}

      {processing && analysisJob?.error && <ErrorNotice>{analysisJob.error}</ErrorNotice>}

      {processing && canWrite && batch.status !== 'excluded' && (
        <div className={s.actions}>
          {analysisJob?.status === 'failed' && (
            <Button variant="secondary" size="sm" onClick={() => void analysisAction('retry')}>
              Analyse opnieuw proberen
            </Button>
          )}

          <Button variant="ghost" size="sm" onClick={() => void analysisAction('skip')}>
            Handmatig verder
          </Button>
        </div>
      )}

      {analysisJob?.status === 'done' &&
        !observations.length &&
        !(data.assessments || []).some((a) => a.batchId === batch.id) && (
          <p className={s.muted}>
            Analyse afgerond zonder bevindingen. Controleer de media voordat je de opname
            beoordeelt.
          </p>
        )}

      {review && batch.status !== 'excluded' && (
        <>
          {observations.map((o) => (
            <ObservationEditor
              key={o.id}
              observation={o}
              scope={scope}
              inspectionId={data.inspection.id}
              path={path}
              canWrite={canWrite}
              pending={pending}
            />
          ))}

          {canWrite && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus size={15} />}
              onClick={async () => {
                try {
                  await api(
                    `${path}/batches/${batch.id}/observations`,

                    json('POST', {
                      id: uuid(),

                      title: '',

                      description: '',

                      label: '',

                      status: 'draft',
                    }),
                  );

                  announceRefresh();
                } catch (e) {
                  setError(errorText(e));
                }
              }}
            >
              Bevinding toevoegen
            </Button>
          )}
        </>
      )}

      {!review &&
        observations.map((o) => (
          <p key={o.id} className={s.observationSummary}>
            {o.source === 'mock' && <Badge tone="ai">Voorbeeldvoorstel</Badge>}

            {o.source === 'ai' && <Badge tone="ai">AI-voorstel</Badge>}

            <strong>{o.title || 'Nog te beschrijven'}</strong>
          </p>
        ))}

      {review && canWrite && (
        <div className={s.batchFooter}>
          {batch.status === 'excluded' ? (
            <Button variant="secondary" onClick={() => void mark('pending')} disabled={queued}>
              Opnieuw beoordelen
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => void mark('excluded')} disabled={queued}>
                Uitsluiten van rapport
              </Button>

              {observations.length === 0 && (
                <Button
                  variant="secondary"
                  icon={<CheckCheck size={17} />}
                  onClick={() => void mark('reviewed')}
                  disabled={
                    queued ||
                    processing ||
                    observations.some((o) => o.status === 'draft') ||
                    batch.status === 'reviewed'
                  }
                >
                  Opname goedkeuren
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {queued && (
        <p className={s.muted} role="status">
          Wijziging op apparaat · wacht op synchronisatie
        </p>
      )}

      {error && <ErrorNotice>{error}</ErrorNotice>}
    </article>
  );
}

export function suggestedObservationTitle(description: string) {
  const line = description.trim().split('\n')[0],
    encoder = new TextEncoder();
  if (encoder.encode(line).length <= 160) return line;
  let title = '';
  for (const char of line) {
    if (encoder.encode(title + char).length > 157) break;
    title += char;
  }
  return title.trimEnd() + '...';
}

export function ObservationEditor({
  observation: initial,
  scope,
  inspectionId,
  path,
  canWrite,
  pending,
}: {
  observation: Observation;
  scope: string;
  inspectionId: string;
  path: string;
  canWrite: boolean;
  pending: Action[];
}) {
  const key = `${scope}:observation:${initial.id}`;
  const [draft, setDraft] = useState(initial),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState('');
  const queued = pending.some((p) => p.path.endsWith(initial.id));
  const descriptionInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (descriptionInput.current) {
      descriptionInput.current.style.height = 'auto';
      descriptionInput.current.style.height = `${descriptionInput.current.scrollHeight}px`;
    }
  }, [draft.description]);
  useEffect(() => {
    let alive = true;
    void draftGet<Observation>(key)
      .then((saved) => {
        if (alive && saved?.id === initial.id) {
          setDraft(saved);
          setDirty(true);
        }
      })
      .catch((e) => setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [key, initial.id]);
  useEffect(() => {
    if (!dirty && !queued) setDraft(initial);
  }, [initial, dirty, queued]);
  function patch(value: Partial<Observation>) {
    const next = { ...draft, ...value };
    setDraft(next);
    setDirty(true);
    void draftPut(key, next).catch((e) => setError(`Niet op apparaat opgeslagen: ${errorText(e)}`));
  }
  async function decide(status: Observation['status']) {
    setError('');
    try {
      await enqueueEdit(scope, inspectionId, `${path}/observations/${initial.id}`, {
        title: draft.title.trim() || suggestedObservationTitle(draft.description),
        description: draft.description,
        label: draft.label,
        status,
        version: draft.version,
      });
      await draftRemove(key);
      setDirty(false);
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <section className={s.observation} aria-label="Bevinding beoordelen">
      <div className={s.actions}>
        {initial.source === 'mock' && <Badge tone="ai">Voorbeeldvoorstel</Badge>}
        {initial.source === 'ai' && <Badge tone="ai">AI-voorstel</Badge>}
        <Badge
          tone={
            initial.status === 'approved'
              ? 'success'
              : initial.status === 'rejected'
                ? 'neutral'
                : 'warning'
          }
        >
          {initial.status === 'approved'
            ? 'Goedgekeurd'
            : initial.status === 'rejected'
              ? 'Afgewezen'
              : 'Te beoordelen'}
        </Badge>
      </div>
      {canWrite ? (
        <>
          <Field
            label="Titel bevinding"
            value={draft.title}
            disabled={queued}
            placeholder="Wordt uit je beschrijving overgenomen"
            maxLength={160}
            onChange={(e) => patch({ title: e.target.value })}
          />
          <label className={s.field}>
            <span>Beschrijving</span>
            <textarea
              ref={descriptionInput}
              aria-label="Beschrijving"
              rows={3}
              maxLength={10000}
              value={draft.description}
              disabled={queued}
              onChange={(e) => {
                patch({ description: e.target.value });
                e.target.style.height = 'auto';
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              placeholder="Wat zie je op de foto's?"
            />
          </label>
          <Field
            label="Label (optioneel)"
            value={draft.label}
            maxLength={100}
            disabled={queued}
            onChange={(e) => patch({ label: e.target.value })}
          />
          <div className={s.reviewDecisions}>
            <Button
              icon={<Check size={18} />}
              disabled={
                queued || !draft.description.trim() || (!dirty && initial.status === 'approved')
              }
              onClick={() => void decide('approved')}
            >
              Goedkeuren
            </Button>
            <Button
              variant="secondary"
              disabled={queued || (!dirty && initial.status === 'rejected')}
              onClick={() => void decide('rejected')}
            >
              Afwijzen
            </Button>
          </div>
        </>
      ) : (
        <>
          <h3>{draft.title}</h3>
          <p className={s.description}>{draft.description}</p>
          {draft.label && <Badge>{draft.label}</Badge>}
        </>
      )}
      {dirty && (
        <p className={s.muted}>
          Concept op apparaat. Goedkeuren of afwijzen bewaart je wijzigingen.
        </p>
      )}
      {queued && (
        <p role="status" className={s.muted}>
          Wacht op synchronisatie
        </p>
      )}
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </section>
  );
}
