import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Dialog, Field } from '../components/ui';
import { api, can, json, uuid } from './api';
import type { Agreement, Dossier, Inspection, InspectionFormat, Organisation } from './types';
import { enqueueEdit } from './outbox';
import type { Action } from './outbox';
import { announceRefresh, dateLabel, errorText, ErrorNotice, Select } from './shared';
import { useResource } from './useResource';
import s from './workspace.module.css';
import { EvidenceThumbnail } from './EvidenceThumbnail';

type Member = { id: string; name: string; reviewer: boolean; writer: boolean };
const localTime = (value?: string | null) =>
  value
    ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : '';
export function VisitWorkflow({
  path,
  base,
  scope,
  data,
  org,
  pending,
}: {
  path: string;
  base: string;
  scope: string;
  data: Dossier;
  org: Organisation;
  pending: Action[];
}) {
  const inspection = data.inspection;
  const { data: members } = useResource<Member[]>(scope, `${base}/planning-members`);
  const [followup, setFollowup] = useState(false);
  const write =
    can(org, 'inspections.write') && inspection.status === 'draft' && !inspection.archivedAt;
  return (
    <section className={s.stack} aria-label="Bezoek en afspraken">
      <div className={s.actions}>
        <Link to={`/app/properties/${inspection.propertyId}`}>Woninghistorie</Link>
        {inspection.predecessorId && (
          <Link to={`/app/inspections/${inspection.predecessorId}/report`}>Vorige inspectie</Link>
        )}
        {inspection.status === 'final' &&
          !inspection.archivedAt &&
          can(org, 'inspections.write') && (
            <Button variant="secondary" onClick={() => setFollowup(true)}>
              Vervolginspectie starten
            </Button>
          )}
      </div>
      <section className={`${s.panel} ${s.stack}`}>
        <h2>Bezoek en planning</h2>
        <Planning
          key={inspection.revision}
          path={path}
          inspection={inspection}
          members={members || []}
          editable={write}
          canPlan={can(org, 'inspections.plan')}
          onDone={announceRefresh}
        />
      </section>
      <section className={`${s.panel} ${s.stack}`}>
        <h2>Afspraken en opvolging</h2>
        <Agreements path={path} scope={scope} data={data} editable={write} pending={pending} />
      </section>
      {can(org, 'inspections.review') && (
        <section className={`${s.panel} ${s.stack}`}>
          <h2>Kwaliteitscontrole</h2>
          <Quality path={path} inspection={inspection} />
        </section>
      )}
      <Dialog
        open={followup}
        onOpenChange={setFollowup}
        title="Vervolginspectie"
        description={inspection.address}
        closeLabel="Sluiten"
      >
        <Followup path={path} base={base} scope={scope} inspection={inspection} />
      </Dialog>
    </section>
  );
}

function Planning({
  path,
  inspection: i,
  members,
  editable,
  canPlan,
  onDone,
}: {
  path: string;
  inspection: Inspection;
  members: Member[];
  editable: boolean;
  canPlan: boolean;
  onDone: () => void;
}) {
  const [assignedTo, setAssigned] = useState(i.assignedTo || ''),
    [scheduled, setScheduled] = useState(localTime(i.scheduledAt)),
    [visited, setVisited] = useState(localTime(i.visitedAt)),
    [priority, setPriority] = useState(i.priority || 'normal'),
    [outcome, setOutcome] = useState(i.visitOutcome || 'scheduled'),
    [reference, setReference] = useState(i.externalReference || ''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className={s.stack}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await api(
            `${path}/${canPlan ? 'planning' : 'visit'}`,
            json(
              'PUT',
              canPlan
                ? {
                    version: i.revision,
                    assignedTo: assignedTo || null,
                    scheduledAt: scheduled ? new Date(scheduled).toISOString() : null,
                    visitedAt: visited ? new Date(visited).toISOString() : null,
                    priority,
                    visitOutcome: outcome,
                    externalReference: reference,
                  }
                : {
                    version: i.revision,
                    visitedAt: visited ? new Date(visited).toISOString() : null,
                    visitOutcome: outcome,
                  },
            ),
          );
          announceRefresh();
          onDone();
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={!editable || busy} className={s.stack}>
        <fieldset disabled={!canPlan}>
          <Select label="Inspecteur" value={assignedTo} onChange={setAssigned}>
            <option value="">Niet toegewezen</option>
            {members
              .filter((m) => m.writer)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </Select>
          <Field
            label="Gepland bezoek"
            type="datetime-local"
            value={scheduled}
            onChange={(e) => setScheduled(e.target.value)}
          />
        </fieldset>
        <Field
          label="Werkelijke bezoekdatum"
          type="datetime-local"
          value={visited}
          onChange={(e) => setVisited(e.target.value)}
        />
        <Select
          label="Bezoekstatus"
          value={outcome}
          onChange={(v) => setOutcome(v as typeof outcome)}
        >
          <option value="scheduled">Gepland</option>
          <option value="visited">Bezocht</option>
          <option value="no_access">Geen toegang</option>
          <option value="cancelled">Geannuleerd</option>
        </Select>
        <fieldset disabled={!canPlan}>
          <Select
            label="Prioriteit"
            value={priority}
            onChange={(v) => setPriority(v as typeof priority)}
          >
            <option value="normal">Normaal</option>
            <option value="high">Hoog</option>
            <option value="urgent">Urgent</option>
          </Select>
          <Field
            label="Externe zaakreferentie"
            value={reference}
            maxLength={240}
            onChange={(e) => setReference(e.target.value)}
          />
        </fieldset>
      </fieldset>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {editable && (
        <Button type="submit" loading={busy}>
          Planning bewaren
        </Button>
      )}
    </form>
  );
}
function Quality({ path, inspection: i }: { path: string; inspection: Inspection }) {
  const [note, setNote] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function record(action: string) {
    setBusy(true);
    setError('');
    try {
      await api(`${path}/quality-review`, json('POST', { version: i.revision, action, note }));
      announceRefresh();
      setNote('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={s.stack}>
      <p>
        {i.reviewStatus === 'approved'
          ? 'Gecontroleerd'
          : i.reviewStatus === 'changes_requested'
            ? 'Aandachtspunten vastgelegd'
            : 'Nog niet gecontroleerd'}{' '}
        · Deze controle blokkeert het afronden niet.
      </p>
      {i.reviewNote && <p>{i.reviewNote}</p>}
      <Field
        label="Toelichting controle"
        value={note}
        maxLength={4000}
        onChange={(e) => setNote(e.target.value)}
      />
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <div className={s.actions}>
        <Button loading={busy} onClick={() => void record('approved')}>
          Controle vastleggen
        </Button>
        <Button
          variant="secondary"
          disabled={!note.trim()}
          loading={busy}
          onClick={() => void record('changes_requested')}
        >
          Aandachtspunten vastleggen
        </Button>
      </div>
    </div>
  );
}
const emptyAgreement = (): Agreement => ({
  id: uuid(),
  description: '',
  responsibility: 'corporation',
  dueDate: null,
  status: 'open',
  note: '',
  photoIds: [],
  version: 0,
});
export function Agreements({
  path,
  scope,
  data,
  editable,
  pending,
}: {
  path: string;
  scope: string;
  data: Dossier;
  editable: boolean;
  pending: Action[];
}) {
  const [draft, setDraft] = useState<Agreement>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const records = new Map((data.agreements || []).map((a) => [a.id, a]));
  for (const action of pending.filter((a) => a.path.startsWith(`${path}/agreements/`))) {
    const a = action.payload as Agreement;
    records.set(a.id, a);
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      await enqueueEdit(scope, data.inspection.id, `${path}/agreements/${draft.id}`, {
        id: draft.id,
        description: draft.description,
        responsibility: draft.responsibility,
        dueDate: draft.dueDate,
        status: draft.status,
        note: draft.note,
        photoIds: draft.photoIds,
        version: draft.version,
      });
      setDraft(undefined);
      announceRefresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={s.stack}>
      {[...records.values()].map((a) => (
        <article key={a.id} className={s.panel}>
          <strong>{a.description}</strong>
          <p>
            {a.responsibility === 'resident' ? 'Bewoner' : 'Corporatie'} ·{' '}
            {a.dueDate || 'Geen deadline'} · {agreementStatus[a.status]}
          </p>
          {a.note && <p>{a.note}</p>}
          {editable && (
            <Button variant="secondary" onClick={() => setDraft(a)}>
              Afspraak bijwerken
            </Button>
          )}
        </article>
      ))}
      {!records.size && <p>Nog geen afspraken vastgelegd.</p>}
      {editable && !draft && (
        <Button onClick={() => setDraft(emptyAgreement())}>Afspraak toevoegen</Button>
      )}
      {draft && (
        <form
          className={s.stack}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field
            label="Afspraak"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            required
            maxLength={4000}
          />
          <Select
            label="Verantwoordelijk"
            value={draft.responsibility}
            onChange={(v) =>
              setDraft({ ...draft, responsibility: v as Agreement['responsibility'] })
            }
          >
            <option value="corporation">Corporatie</option>
            <option value="resident">Bewoner</option>
          </Select>
          <Field
            label="Deadline"
            type="date"
            value={draft.dueDate || ''}
            onChange={(e) => setDraft({ ...draft, dueDate: e.target.value || null })}
          />
          <Select
            label="Afspraakstatus"
            value={draft.status}
            onChange={(v) => setDraft({ ...draft, status: v as Agreement['status'] })}
          >
            {Object.entries(agreementStatus).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </Select>
          <Field
            label="Toelichting of controlebewijs"
            value={draft.note}
            onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            maxLength={4000}
          />
          <fieldset className={s.evidenceChoices}>
            <legend>Bronfoto’s</legend>
            {data.media
              .filter((m) => m.kind === 'photo')
              .map((m) => (
                <button
                  type="button"
                  key={m.id}
                  className={s.evidenceChoice}
                  aria-label={`Selecteer ${m.name}`}
                  aria-pressed={draft.photoIds.includes(m.id)}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      photoIds: draft.photoIds.includes(m.id)
                        ? draft.photoIds.filter((id) => id !== m.id)
                        : [...draft.photoIds, m.id],
                    })
                  }
                >
                  <EvidenceThumbnail org={path.split('/')[2]} id={m.id} name={m.name} />
                  <span>{draft.photoIds.includes(m.id) ? 'Geselecteerd' : 'Selecteren'}</span>
                </button>
              ))}
          </fieldset>
          <div className={s.actions}>
            <Button type="submit" disabled={!draft.description.trim()} loading={busy}>
              Afspraak bewaren
            </Button>
            <Button variant="ghost" onClick={() => setDraft(undefined)}>
              Annuleren
            </Button>
          </div>
        </form>
      )}
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </div>
  );
}
export const agreementStatus: Record<Agreement['status'], string> = {
  open: 'Open',
  completed: 'Gecontroleerd afgerond',
  disputed: 'Betwist',
  withdrawn: 'Ingetrokken',
};
function Followup({
  path,
  base,
  scope,
  inspection: i,
}: {
  path: string;
  base: string;
  scope: string;
  inspection: Inspection;
}) {
  const navigate = useNavigate(),
    { data: formats } = useResource<InspectionFormat[]>(scope, `${base}/formats`);
  const [format, setFormat] = useState(''),
    [reference, setReference] = useState(i.externalReference || ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [nextID] = useState(uuid);
  return (
    <form
      className={s.stack}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          const result = await api<{ id: string }>(
            `${path}/followups`,
            json('POST', { id: nextID, version: i.revision, formatVersionId: format, reference }),
          );
          navigate(`/app/inspections/${result.id}/capture`);
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p>
        Ruimtes en open afspraken gaan mee. Antwoorden over de huidige staat worden opnieuw
        opgenomen en beoordeeld.
      </p>
      <Select label="Inspectiesjabloon vervolginspectie" value={format} onChange={setFormat}>
        <option value="">Kies een sjabloon</option>
        {formats
          ?.filter((f) => f.status === 'published')
          .map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} · versie {f.number}
            </option>
          ))}
      </Select>
      <Field
        label="Zaakreferentie"
        value={reference}
        onChange={(e) => setReference(e.target.value)}
        maxLength={240}
      />
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <Button type="submit" disabled={!format} loading={busy}>
        Vervolginspectie maken
      </Button>
    </form>
  );
}
export function PropertyHistory({
  base,
  scope,
  propertyID,
}: {
  base: string;
  scope: string;
  propertyID: string;
}) {
  const { data, error } = useResource<Inspection[]>(
    scope,
    `${base}/properties/${propertyID}/history`,
  );
  return (
    <section className={s.stack}>
      <Link to="/app">Alle inspecties</Link>
      <h1>Woninghistorie</h1>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {data?.[0] && (
        <p>
          {data[0].address} · Overzicht van eerdere bezoeken en vastgestelde rapporten voor deze
          woning. Wijzigingen binnen één dossier staan in Dossierhistorie.
        </p>
      )}
      <div className={s.tableScroll}>
        <table className={s.historyTable}>
          <thead>
            <tr>
              <th>Bezoekdatum</th>
              <th>Type</th>
              <th>Inspecteur</th>
              <th>Status</th>
              <th>Rapport</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((i) => (
              <tr key={i.id}>
                <td>{dateLabel(i.visitedAt || i.scheduledAt)}</td>
                <td>{i.kind === 'final' ? 'Eindinspectie' : 'Voorinspectie'}</td>
                <td>{i.inspectorName || 'Niet vastgelegd'}</td>
                <td>
                  {i.archivedAt ? 'Gearchiveerd' : i.status === 'final' ? 'Vastgelegd' : 'Concept'}
                </td>
                <td>
                  <Link
                    to={`/app/inspections/${i.id}/${i.status === 'final' ? 'report' : 'capture'}`}
                  >
                    Dossier openen
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
