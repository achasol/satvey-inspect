import { networkOnline } from './connectivity';
import { useState } from 'react';
import { Archive, History, RotateCcw, Trash2 } from 'lucide-react';
import { Button, Dialog, Field } from '../components/ui';
import { api, json } from './api';
import type { Dossier, Inspection } from './types';
import { useResource } from './useResource';
import { actions, forgetInspection, pendingDraftCount } from './outbox';
import { announceRefresh, ErrorNotice, errorText } from './shared';
import s from './workspace.module.css';

export function ArchiveInspection({
  base,
  scope,
  inspection,
  iconOnly = false,
  onDeleted,
  canManage = false,
  canPurge = false,
}: {
  base: string;
  scope: string;
  inspection: Inspection;
  iconOnly?: boolean;
  onDeleted?: () => void;
  canManage?: boolean;
  canPurge?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [purge, setPurge] = useState(false);
  const archived = !!inspection.archivedAt;
  if ((inspection.status === 'final' || archived) && !canManage) return null;
  const label = purge
    ? 'Definitief verwijderen'
    : archived
      ? 'Inspectie herstellen'
      : 'Inspectie archiveren';
  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (!networkOnline()) throw new Error('Maak verbinding met internet.');
      const path = `${base}/inspections/${inspection.id}`;
      const dossier = await api<Dossier>(path),
        ids = dossier.observations.map((o) => o.id);
      if (
        (await pendingDraftCount(scope, inspection.id, ids)) ||
        (await actions(scope)).some((a) => a.inspectionId === inspection.id)
      )
        throw new Error('Bewaar en synchroniseer eerst de lokale wijzigingen van dit dossier.');
      if (dossier.inspection.revision !== inspection.revision)
        throw new Error('Het dossier is gewijzigd. Herlaad voordat je doorgaat.');
      await api(
        `${path}/${purge ? 'purge' : archived ? 'restore' : 'archive'}`,
        json(purge ? 'DELETE' : 'POST', { reason, version: inspection.revision }),
      );
      if (purge) await forgetInspection(scope, path, inspection.id, ids);
      setOpen(false);
      setReason('');
      onDeleted?.();
      announceRefresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={archived ? <RotateCcw size={17} /> : <Archive size={17} />}
        aria-label={
          iconOnly
            ? `${archived ? 'Inspectie herstellen' : 'Inspectie archiveren'}: ${inspection.address}`
            : undefined
        }
        title={label}
        onClick={() => {
          setPurge(false);
          setError('');
          setOpen(true);
        }}
      >
        {!iconOnly && (archived ? 'Inspectie herstellen' : 'Inspectie archiveren')}
      </Button>
      {archived && canPurge && (
        <Button
          variant="ghost"
          size="sm"
          icon={<Trash2 size={17} />}
          onClick={() => {
            setPurge(true);
            setError('');
            setOpen(true);
          }}
        >
          Definitief verwijderen
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!busy) setOpen(v);
        }}
        title={label}
        description={inspection.address}
        closeLabel="Sluiten"
      >
        <div className={s.stack}>
          <p>
            {purge
              ? 'Deze handeling verwijdert het dossier en bronbewijs permanent. Eerder ontvangen kopieën blijven bij de ontvanger. Er blijft een minimale verwijderregistratie bestaan.'
              : archived
                ? 'Het dossier wordt weer zichtbaar in de actieve lijst.'
                : 'Het dossier en bronbewijs blijven bewaard. Een beheerder kan het later herstellen.'}
          </p>
          <Field
            label="Reden"
            value={reason}
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
            required
          />
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <div className={s.actions}>
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              Annuleren
            </Button>
            <Button
              variant={purge ? 'destructive' : 'primary'}
              disabled={!reason.trim()}
              loading={busy}
              onClick={() => void submit()}
            >
              {label}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

type HistoryEvent = {
  id: number;
  action: string;
  actor: string;
  createdAt: string;
  detail: Record<string, unknown>;
};
export function DossierHistory({
  path,
  inspection,
}: {
  path: string;
  inspection: Inspection;
  canWrite: boolean;
  canManage?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [events, setEvents] = useState<HistoryEvent[]>([]),
    [error, setError] = useState('');
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        icon={<History size={17} />}
        onClick={async () => {
          setOpen(true);
          setError('');
          try {
            setEvents(await api<HistoryEvent[]>(`${path}/history`));
          } catch (e) {
            setError(errorText(e));
          }
        }}
      >
        Dossierhistorie
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Dossierhistorie"
        description={inspection.address}
        closeLabel="Sluiten"
      >
        <div className={s.stack}>
          {error && <ErrorNotice>{error}</ErrorNotice>}
          {!events.length && (
            <p>
              Geen geregistreerde gebeurtenissen. Oudere dossiers hebben mogelijk nog geen volledige
              historie.
            </p>
          )}
          <ol className={s.auditList}>
            {events.map((event) => (
              <li key={event.id}>
                <strong>{eventLabel(event.action)}</strong>
                <p>
                  {event.actor} · {new Date(event.createdAt).toLocaleString('nl-NL')}
                </p>
                {typeof event.detail.reason === 'string' && <p>{event.detail.reason}</p>}
                {typeof event.detail.note === 'string' && <p>{event.detail.note}</p>}
                {event.detail.changes && typeof event.detail.changes === 'object' ? (
                  <dl>
                    {Object.entries(
                      event.detail.changes as Record<string, { before: unknown; after: unknown }>,
                    ).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key.replaceAll('_', ' ')}</dt>
                        <dd>
                          <del>{auditValue(value.before)}</del> →{' '}
                          <span>{auditValue(value.after)}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      </Dialog>
    </>
  );
}
function auditValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function DeletionProtection({ base, scope }: { base: string; scope: string }) {
  const [query, setQuery] = useState(''),
    [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const { data, reload } = useResource<{ items: Inspection[] }>(
    scope,
    `${base}/inspection-page?limit=25&q=${encodeURIComponent(query)}&view=all`,
  );
  return (
    <section className={`${s.panel} ${s.stack}`}>
      <h3>Beschermen tegen verwijderen</h3>
      <p>
        Bescherming voorkomt verwijderen en automatische opschoning. Bewerken blijft toegestaan.
      </p>
      <Field label="Dossier zoeken" value={query} onChange={(e) => setQuery(e.target.value)} />
      <Field
        label="Reden wijziging"
        value={reason}
        maxLength={2000}
        onChange={(e) => setReason(e.target.value)}
      />
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {data?.items.map((i) => (
        <div className={s.protectionRow} key={i.id}>
          <span>
            {i.address} · {i.retentionHold ? 'Beschermd' : 'Niet beschermd'}
          </span>
          <Button
            variant="secondary"
            disabled={busy || !reason.trim()}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await api(
                  `${base}/inspections/${i.id}/retention-hold`,
                  json('PUT', { version: i.revision, hold: !i.retentionHold, reason }),
                );
                reload();
                announceRefresh();
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {i.retentionHold ? 'Bescherming opheffen' : 'Beschermen'}
          </Button>
        </div>
      ))}
    </section>
  );
}
const eventLabels: Record<string, string> = {
  archived: 'Gearchiveerd',
  restored: 'Hersteld',
  purged: 'Definitief verwijderd',
  report_finalised: 'Rapportversie vastgelegd',
  report_editing_started: 'Nieuwe conceptversie gestart',
  correction_started: 'Correctie gestart',
  correction_draft_created: 'Correctiedossier aangemaakt',
  planning_updated: 'Planning en toewijzing bijgewerkt',
  visit_recorded: 'Bezoekgegevens vastgelegd',
  quality_requested: 'Kwaliteitscontrole aangevraagd',
  quality_approved: 'Kwaliteitscontrole goedgekeurd',
  quality_changes_requested: 'Wijzigingen gevraagd na kwaliteitscontrole',
  retention_hold: 'Bewaarblokkade gewijzigd',
  retention_applied: 'Bewaarbeleid uitgevoerd',
  report_email_queued: 'Rapport klaargezet voor e-mail',
  followup_created: 'Vervolginspectie aangemaakt',
  manual_handover_recorded: 'Handmatige overdracht geregistreerd',
  pilot_measurement: 'Tijdmeting vastgelegd',
  evidence_moved: 'Bronbewijs naar een andere ruimte verplaatst',
  observations_insert: 'Bevinding toegevoegd',
  observations_update: 'Bevinding bijgewerkt',
  batches_insert: 'Opname aangemaakt',
  batches_update: 'Opname bijgewerkt',
  media_insert: 'Bronbestand toegevoegd',
  media_update: 'Bronbestand bijgewerkt',
  format_answers_insert: 'Antwoord aangemaakt',
  format_answers_update: 'Antwoord bijgewerkt',
  rooms_insert: 'Ruimte toegevoegd',
  rooms_update: 'Ruimte bijgewerkt',
  inspection_agreements_insert: 'Afspraak toegevoegd',
  inspection_agreements_update: 'Afspraak bijgewerkt',
};
function eventLabel(action: string) {
  return eventLabels[action] || 'Dossier bijgewerkt';
}
