import type { Dossier, Report } from './api';
import { Gallery } from './capture';
import { answerText } from './FormatReview';
import { ScoreSummary } from './Scoring';
import { outcomeLabels } from './labels';
import { agreementStatus } from './VisitWorkflow';
import s from './workspace.module.css';

export function ReportContent({ data, org }: { data: Dossier | Report; org: string }) {
  const issued = 'createdAt' in data;
  const reviewed = new Set(data.batches.filter((b) => b.status === 'reviewed').map((b) => b.id));
  const observations = issued
    ? data.observations
    : (data as Dossier).observations.filter(
        (o) => o.status === 'approved' && reviewed.has(o.batchId),
      );
  const answers = (data.answers || []).filter(
    (a) =>
      ['confirmed', 'unanswerable'].includes(a.status) &&
      data.rooms.some((r) => r.id === a.roomId && r.generation === r.approvedGeneration),
  );
  const assessments = issued
    ? (data as Report).assessments || []
    : ((data as Dossier).assessments || [])
        .filter((a) => a.reviewedOutcome && !a.stale && reviewed.has(a.batchId))
        .map((a) => ({ ...a, outcome: a.reviewedOutcome!, reason: a.reviewNote || a.reason }));
  const issues = new Set([
    ...answers
      .filter((a) => a.outcome === 'unacceptable')
      .map(
        (a) =>
          `${a.roomId}:${data.format?.scopes.flatMap((s) => s.questions).find((q) => q.id === a.questionId)?.ruleId || a.questionId}`,
      ),
    ...assessments
      .filter((a) => a.outcome === 'unacceptable')
      .map((a) => `${data.batches.find((b) => b.id === a.batchId)?.roomId}:${a.ruleId}`),
  ]);
  const photos = (ids: string[]) =>
    data.media.filter((m) => m.kind === 'photo' && ids.includes(m.id));
  return (
    <div className={s.reportContent}>
      <section className={s.reportOverview} aria-label="Rapport in één oogopslag">
        <div>
          <strong>{observations.length}</strong>
          <span>bevindingen</span>
        </div>
        <div>
          <strong>{issues.size}</strong>
          <span>actiepunten</span>
        </div>
        <div>
          <strong>
            {
              (data.agreements || []).filter((a) => a.status === 'open' || a.status === 'disputed')
                .length
            }
          </strong>
          <span>open afspraken</span>
        </div>
      </section>
      <nav className={s.reportRoomLinks} aria-label="Rapport per ruimte">
        {data.rooms.map((room) => (
          <a key={room.id} href={`#report-room-${room.id}`}>
            {room.name}
          </a>
        ))}
      </nav>
      {data.rooms.map((room, index) => {
        const category = data.format?.scopes.find((c) => c.id === room.categoryId);
        const roomAnswers = answers.filter((a) => a.roomId === room.id);
        const roomObservations = observations.filter(
          (o) => data.batches.find((b) => b.id === o.batchId)?.roomId === room.id,
        );
        const roomAssessments = assessments.filter(
          (a) => data.batches.find((b) => b.id === a.batchId)?.roomId === room.id,
        );
        const seen = new Set<string>();
        return (
          <section key={room.id} id={`report-room-${room.id}`} className={s.reportRoom}>
            <h3>
              {index + 1}. {room.name}
            </h3>
            {room.approvedGeneration !== room.generation && (
              <p className={s.warning}>Deze ruimte is nog niet volledig beoordeeld.</p>
            )}
            {!roomAnswers.length && !roomObservations.length && !roomAssessments.length && (
              <p className={s.muted}>Geen bevestigde waarnemingen vastgelegd voor deze ruimte.</p>
            )}
            {roomAnswers.map((answer) => {
              const question = category?.questions.find((q) => q.id === answer.questionId);
              const text = answerText(answer);
              seen.add(answer.reason.trim().toLowerCase());
              return (
                <article
                  key={answer.id}
                  className={`${s.reportFinding} ${answer.photoIds.length ? s.reportFindingWithPhoto : ''}`}
                >
                  <div>
                    <h4>{question?.title || 'Inspectieresultaat'}</h4>
                    <p>
                      {text}
                      {question?.unit && answer.value !== null ? ` ${question.unit}` : ''}
                    </p>
                    {answer.reason && answer.reason !== text && <p>{answer.reason}</p>}
                    <ScoreSummary value={answer.scoreDetail} />
                  </div>
                  {!!answer.photoIds.length && (
                    <Gallery media={photos(answer.photoIds)} org={org} />
                  )}
                </article>
              );
            })}
            {roomObservations.map((o) => {
              if (seen.has(o.description.trim().toLowerCase())) return null;
              seen.add(o.description.trim().toLowerCase());
              const ids = o.photoIds?.length
                ? o.photoIds
                : data.media
                    .filter((m) => m.kind === 'photo' && m.batchId === o.batchId)
                    .map((m) => m.id);
              return (
                <article
                  key={o.id}
                  className={`${s.reportFinding} ${ids.length ? s.reportFindingWithPhoto : ''}`}
                >
                  <div>
                    <h4>{o.title}</h4>
                    {o.label && <span className={s.reportTag}>{o.label}</span>}
                    <p>{o.description}</p>
                    <small>Referentie {o.id.slice(0, 8).toUpperCase()}</small>
                  </div>
                  {!!ids.length && <Gallery org={org} media={photos(ids)} />}
                </article>
              );
            })}
            {roomAssessments.map((a) => {
              if (
                roomAnswers.some(
                  (answer) =>
                    category?.questions.find((q) => q.id === answer.questionId)?.ruleId ===
                    a.ruleId,
                )
              )
                return null;
              const rule = data.norms?.rules.find((rule) => rule.id === a.ruleId);
              return (
                <article
                  key={`${a.batchId}:${a.ruleId}`}
                  className={`${s.reportFinding} ${a.photoIds?.length ? s.reportFindingWithPhoto : ''}`}
                >
                  <div>
                    <h4>{rule?.title || 'Kwaliteitsbeoordeling'}</h4>
                    <p>{outcomeLabels[a.outcome]}</p>
                    <p>{a.reason}</p>
                    <ScoreSummary value={a.scoreDetail} />
                  </div>
                  {!!a.photoIds?.length && <Gallery org={org} media={photos(a.photoIds)} />}
                </article>
              );
            })}
          </section>
        );
      })}
      {!!data.agreements?.length && (
        <section className={s.reportRoom}>
          <h3>Afspraken en opvolging</h3>
          {data.agreements.map((a) => (
            <article key={a.id} className={s.reportFinding}>
              <h4>{a.description}</h4>
              <p>
                {a.responsibility === 'resident' ? 'Bewoner' : 'Corporatie'} ·{' '}
                {a.dueDate || 'Geen deadline'} · {agreementStatus[a.status]}
              </p>
              {a.note && <p>{a.note}</p>}
              {!!a.photoIds.length && <Gallery org={org} media={photos(a.photoIds)} />}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
