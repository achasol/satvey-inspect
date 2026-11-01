import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { Badge, Button, Checkbox, Field } from '../components/ui';
import { api, ApiError, json, uuid } from './api';
import type { HandoverData, HandoverDelivery, HandoverDraft, WorkProposal } from './api';
import { draftGet, draftPut, draftRemove, cacheGet, cachePut } from './outbox';
import { dateLabel, ErrorNotice, errorText } from './shared';
import { Gallery } from './capture';
import { ManualHandover } from './ManualHandover';
import s from './workspace.module.css';

const urgencyLabels: Record<WorkProposal['urgency'], string> = {
  unspecified: 'Nog te bepalen',
  routine: 'Regulier',
  soon: 'Op korte termijn',
  urgent: 'Urgent',
};
const deliveryLabels: Record<HandoverDelivery['status'], string> = {
  queued: 'In wachtrij',
  processing: 'Verzenden en ontvangst controleren',
  retrying: 'Opnieuw proberen gepland',
  blocked: 'Actie nodig',
  accepted: 'Ontvangen',
  manual: 'Handmatig afgehandeld',
};

export function DeliveryHistory({
  deliveries,
  onRetry,
}: {
  deliveries: HandoverDelivery[];
  onRetry?: (id: string) => void;
}) {
  return (
    <section className={s.stack} aria-label="Overdrachtsstatus">
      <h3>Overdrachtsstatus</h3>
      {!deliveries.length && <p className={s.muted}>Nog geen overdracht goedgekeurd.</p>}
      {deliveries.map((item) => (
        <article key={item.id} className={`${s.panel} ${s.stack}`}>
          <div className={s.reportToolbar}>
            <strong>{item.destination}</strong>
            <Badge
              tone={
                item.status === 'accepted'
                  ? 'success'
                  : item.status === 'blocked'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {deliveryLabels[item.status]}
            </Badge>
          </div>
          <p>
            Versie {item.draftVersion} · goedgekeurd op {dateLabel(item.createdAt)} ·{' '}
            {item.proposals.length} onderhoudsvoorstellen
          </p>
          {item.status === 'manual' ? (
            <p>
              Afgehandeld via het geregistreerde handmatige klantkanaal. Automatische verzending is
              gestopt.
            </p>
          ) : item.acceptedAt ? (
            <p>Ontvangst bevestigd op {dateLabel(item.acceptedAt)}</p>
          ) : (
            <p>
              {item.acceptedCount > 0
                ? `${item.acceptedCount} onderdelen ontvangen; de overdracht is nog niet volledig bevestigd.`
                : 'De server verzorgt de overdracht, ook als je dit scherm sluit.'}
            </p>
          )}
          {item.error && <p className={s.warning}>{item.error}</p>}
          {item.status === 'retrying' && <p>Volgende poging: {dateLabel(item.nextAttemptAt)}</p>}
          {onRetry && ['blocked', 'retrying'].includes(item.status) && (
            <Button
              variant="secondary"
              icon={<RefreshCw size={16} />}
              onClick={() => onRetry(item.id)}
            >
              Opnieuw proberen
            </Button>
          )}
          {!!item.receipts.length && (
            <details>
              <summary>Ontvangen onderdelen ({item.receipts.length})</summary>
              <ul>
                {item.receipts.map((receipt) => (
                  <li key={receipt.key}>
                    {receipt.key.split(':')[0]} · ontvangend kenmerk {receipt.receiverId} ·{' '}
                    {dateLabel(receipt.acceptedAt)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </article>
      ))}
    </section>
  );
}

export function HandoverWorkspace({
  path,
  scope,
  org,
  canWrite,
}: {
  path: string;
  scope: string;
  org: string;
  canWrite: boolean;
}) {
  const [data, setData] = useState<HandoverData>();
  const [draft, setDraft] = useState<HandoverDraft>();
  const [dirty, setDirty] = useState(false),
    [saving, setSaving] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [saveError, setSaveError] = useState(''),
    [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false),
    [latest, setLatest] = useState<HandoverDraft>();
  const [query, setQuery] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [actionableOnly, setActionableOnly] = useState(true);
  const mounted = useRef(false),
    generation = useRef(0),
    current = useRef<HandoverDraft | undefined>(undefined),
    dirtyRef = useRef(false),
    savingRef = useRef(false),
    approvalId = useRef(uuid());
  const key = `${scope}:handover:${path.split('/').pop()}`;
  const persistence = useRef<Promise<unknown>>(Promise.resolve());
  const load = useCallback(async () => {
    const value = await api<HandoverData>(`${path}/handover`);
    if (!mounted.current) return;
    setData(value);
    void cachePut(`${scope}:${path}/handover`, value).catch(() => {});
    if (!dirtyRef.current && !savingRef.current) {
      current.current = value.draft;
      setDraft(value.draft);
    }
  }, [path, scope]);
  useEffect(() => {
    mounted.current = true;
    void Promise.all([
      api<HandoverData>(`${path}/handover`)
        .then((value) => {
          void cachePut(`${scope}:${path}/handover`, value).catch(() => {});
          return value;
        })
        .catch(async (error) => {
          const cached = await cacheGet<HandoverData>(`${scope}:${path}/handover`);
          if (!cached) throw error;
          if (mounted.current)
            setError(
              'Offline: laatst geladen overdracht. Goedkeuren vereist verbinding met de server.',
            );
          return cached;
        }),
      draftGet<HandoverDraft>(key).catch(() => undefined),
    ])
      .then(([value, local]) => {
        if (!mounted.current) return;
        setData(value);
        const restored = local || value.draft;
        current.current = restored;
        setDraft(restored);
        if (local) {
          dirtyRef.current = true;
          setDirty(true);
          setNotice('Lokale wijzigingen hersteld.');
          if (local.version !== value.draft.version) {
            setConflict(true);
            setLatest(value.draft);
          }
        }
      })
      .catch((e) => {
        if (mounted.current) setError(errorText(e));
      });
    return () => {
      mounted.current = false;
    };
  }, [path, key, scope]);
  useEffect(() => {
    if (!data?.deliveries.some((item) => item.status !== 'accepted')) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible')
        void load().catch((e) => {
          if (mounted.current) setError(errorText(e));
        });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [data?.deliveries, load]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) event.preventDefault();
    };
    const online = () => setSaveError('');
    window.addEventListener('beforeunload', warn);
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('beforeunload', warn);
      window.removeEventListener('online', online);
    };
  }, []);
  function change(value: HandoverDraft) {
    generation.current++;
    approvalId.current = uuid();
    current.current = value;
    dirtyRef.current = true;
    setDraft(value);
    setDirty(true);
    setSaveError('');
    setNotice('');
    persistence.current = persistence.current
      .then(() => draftPut(key, value))
      .catch((e) => {
        if (mounted.current) setSaveError(errorText(e));
      });
  }
  const save = useCallback(async () => {
    if (!current.current || savingRef.current) return;
    const value = current.current,
      version = generation.current;
    savingRef.current = true;
    setSaving(true);
    setSaveError('');
    try {
      const saved = await api<HandoverDraft>(`${path}/handover`, json('PUT', value));
      if (!mounted.current) return;
      if (generation.current === version) {
        current.current = saved;
        setDraft(saved);
        dirtyRef.current = false;
        setDirty(false);
        persistence.current = persistence.current.then(() =>
          generation.current === version ? draftRemove(key) : draftPut(key, current.current),
        );
        await persistence.current;
        setNotice('Onderhoudsvoorstellen opgeslagen.');
      } else {
        const newer = { ...current.current!, version: saved.version };
        current.current = newer;
        setDraft(newer);
        persistence.current = persistence.current.then(() => draftPut(key, current.current));
        await persistence.current;
      }
    } catch (e) {
      if (mounted.current) {
        setSaveError(errorText(e));
        if (e instanceof ApiError && e.status === 409) setConflict(true);
      }
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }, [path, key]);
  const valid =
    !!draft &&
    draft.proposals.every(
      (p) =>
        p.description.trim() &&
        ((p.quantity == null && !p.unit) ||
          (p.quantity != null &&
            Number.isFinite(p.quantity) &&
            p.quantity > 0 &&
            p.quantity <= 1e9 &&
            p.unit.trim())),
    );
  useEffect(() => {
    if (!canWrite || !dirty || saving || busy || conflict || saveError || !valid) return;
    const timer = window.setTimeout(() => void save(), 1000);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, saving, busy, conflict, saveError, valid, canWrite, save]);
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  if (!data || !draft)
    return (
      <section className={s.stack}>
        <h2>Overdracht</h2>
        {error ? <ErrorNotice>{error}</ErrorNotice> : <p role="status">Overdracht laden…</p>}
      </section>
    );
  const locked = new Set(data.deliveries.flatMap((item) => item.proposals.map((p) => p.id)));
  const included = new Set(draft.proposals.flatMap((p) => p.sourceKeys));
  const findings = data.report.sources
    .filter(
      (source) =>
        !actionableOnly || source.kind === 'observation' || source.outcome === 'unacceptable',
    )
    .filter((source) =>
      `${source.location} ${source.title} ${source.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  const rooms = Array.from(new Set(findings.map((source) => source.location || 'Woning')));
  const sources = new Map(data.report.sources.map((source) => [source.key, source]));
  const destination = data.destinations.find((item) => item.id === draft.destinationId);
  const active = data.deliveries.some((item) => item.status !== 'accepted');
  const alreadyApproved = data.deliveries.some(
    (item) => item.draftVersion === draft.version && item.destinationId === draft.destinationId,
  );
  const chosen = data.report.sources.filter(
    (source) => selected.includes(source.key) && !included.has(source.key),
  );
  function addProposals(combine: boolean) {
    const groups = combine ? [chosen] : chosen.map((item) => [item]);
    const proposals = groups
      .filter((group) => group.length)
      .map((group) => ({
        id: uuid(),
        sourceKeys: group.map((source) => source.key),
        description: group
          .map((source) => [source.title, source.description].filter(Boolean).join(': '))
          .join('\n')
          .slice(0, 6000),
        location: Array.from(new Set(group.map((source) => source.location)))
          .join(', ')
          .slice(0, 240),
        urgency: 'unspecified' as const,
        elementCode: '',
        unit: '',
      }));
    if (draft!.proposals.length + proposals.length > 200) {
      setError('Een overdracht kan maximaal 200 onderhoudsvoorstellen bevatten.');
      return;
    }
    change({ ...draft!, proposals: [...draft!.proposals, ...proposals] });
    setSelected([]);
  }
  return (
    <section className={s.stack} aria-label="Overdracht">
      <div className={s.pageHeading}>
        <div>
          <h2>Overdracht</h2>
          <p className={s.muted}>
            Kies bevindingen, controleer de voorgestelde werkzaamheden en keur de overdracht goed.
            Daarna verzorgt Satvey de verzending via VERA.
          </p>
        </div>
      </div>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <ManualHandover path={path} scope={scope} reportId={data.report.id} canWrite={canWrite} />
      <label>
        <input
          type="checkbox"
          checked={actionableOnly}
          onChange={(e) => setActionableOnly(e.target.checked)}
        />{' '}
        Alleen bevindingen en niet-acceptabele beoordelingen
      </label>
      <div role="status" aria-live="polite">
        {saving
          ? 'Wijzigingen opslaan…'
          : saveError
            ? 'Wijzigingen staan lokaal; opslaan is nog niet gelukt.'
            : dirty
              ? 'Wijzigingen op dit apparaat; nog niet op de server.'
              : notice || 'Alle wijzigingen opgeslagen.'}
      </div>
      {saveError && <ErrorNotice>{saveError}</ErrorNotice>}
      {!valid && (
        <p className={s.warning}>
          Vul bij elk voorstel een werkomschrijving in. Een hoeveelheid vereist een meeteenheid.
        </p>
      )}
      <div className={s.twoColumns}>
        <label className={s.field}>
          <span>Ontvangend systeem</span>
          <select
            aria-label="Ontvangend systeem"
            value={draft.destinationId || ''}
            disabled={!canWrite || busy}
            onChange={(e) => {
              const next = data.destinations.find((item) => item.id === e.target.value);
              change({ ...draft, destinationId: next?.id || '', destination: next?.name || '' });
            }}
          >
            <option value="">Kies een bestemming</option>
            {data.destinations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.ready ? '' : ` · ${item.reason}`}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="Externe zaak- of orderreferentie (optioneel)"
          maxLength={512}
          disabled={!canWrite || busy}
          value={draft.externalReference}
          onChange={(e) => change({ ...draft, externalReference: e.target.value })}
        />
      </div>
      {(!data.destinations.length || (destination && !destination.ready)) && (
        <p className={s.warning}>
          {destination?.reason || 'Er is nog geen VERA-bestemming ingesteld.'} Een beheerder kan dit
          oplossen bij <Link to="/app/settings?tab=handover">VERA-overdracht</Link>.
        </p>
      )}
      {canWrite && (
        <section className={`${s.panel} ${s.stack}`} aria-label="Bevindingen selecteren">
          <h3>Bevindingen uit het rapport</h3>
          <Field
            label="Bevindingen zoeken"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Zoek op ruimte, element of omschrijving"
          />
          <div className={s.handoverSelection}>
            <strong>{chosen.length} geselecteerd</strong>
            <Button
              variant="secondary"
              disabled={!chosen.length || busy}
              icon={<Plus size={16} />}
              onClick={() => addProposals(false)}
            >
              Onderhoudsvoorstellen maken
            </Button>
            {chosen.length > 1 && (
              <Button variant="ghost" disabled={busy} onClick={() => addProposals(true)}>
                Combineren tot één voorstel
              </Button>
            )}
          </div>
          {!findings.length && <p>Geen bevindingen gevonden.</p>}
          {rooms.map((room) => {
            const group = findings.filter((source) => (source.location || 'Woning') === room),
              available = group.filter((source) => !included.has(source.key)),
              all =
                available.length > 0 && available.every((source) => selected.includes(source.key));
            return (
              <section key={room} className={s.stack} aria-label={`Bevindingen ${room}`}>
                <div className={s.reportToolbar}>
                  <h4>{room}</h4>
                  <Checkbox
                    label={`Selecteer alle getoonde bevindingen in ${room}`}
                    checked={all}
                    disabled={!available.length || busy}
                    onCheckedChange={(checked) =>
                      setSelected((previous) =>
                        checked
                          ? Array.from(
                              new Set([...previous, ...available.map((source) => source.key)]),
                            )
                          : previous.filter(
                              (key) => !available.some((source) => source.key === key),
                            ),
                      )
                    }
                  />
                </div>
                {group.map((source) => (
                  <article key={source.key} className={`${s.handoverFinding} ${s.panel}`}>
                    <div className={s.stack}>
                      <Checkbox
                        label={source.title}
                        checked={selected.includes(source.key) || included.has(source.key)}
                        disabled={included.has(source.key) || busy}
                        onCheckedChange={(checked) =>
                          setSelected((previous) =>
                            checked
                              ? [...previous, source.key]
                              : previous.filter((key) => key !== source.key),
                          )
                        }
                      />
                      {included.has(source.key) && <Badge>Al toegevoegd</Badge>}
                      {source.outcome === 'unacceptable' && (
                        <Badge tone="warning">Niet acceptabel</Badge>
                      )}
                      <details>
                        <summary>Omschrijving en onderbouwing</summary>
                        <p className={s.description}>{source.description}</p>
                        {source.value != null && (
                          <p>
                            Vastgelegd antwoord:{' '}
                            {typeof source.value === 'boolean'
                              ? source.value
                                ? 'Ja'
                                : 'Nee'
                              : String(source.value)}
                          </p>
                        )}
                      </details>
                    </div>
                    {!!source.photoIds.length && (
                      <Gallery
                        org={org}
                        media={source.photoIds.map((id) => ({
                          id,
                          batchId: '',
                          kind: 'photo' as const,
                          name: 'Rapportfoto',
                          mime: 'image/jpeg',
                        }))}
                      />
                    )}
                  </article>
                ))}
              </section>
            );
          })}
        </section>
      )}
      <section className={s.stack} aria-label="Onderhoudsvoorstellen">
        <h3>Onderhoudsvoorstellen ({draft.proposals.length})</h3>
        {!draft.proposals.length && (
          <p className={s.muted}>
            Je kunt ook alleen het inspectierapport en de bijlagen overdragen.
          </p>
        )}
        {draft.proposals.map((proposal, index) => {
          const frozen = locked.has(proposal.id),
            disabled = !canWrite || busy || frozen;
          const update = (fields: Partial<WorkProposal>) =>
            change({
              ...draft,
              proposals: draft.proposals.map((item) =>
                item.id === proposal.id ? { ...item, ...fields } : item,
              ),
            });
          return (
            <fieldset key={proposal.id} className={`${s.panel} ${s.stack}`} disabled={disabled}>
              <legend>Onderhoudsvoorstel {index + 1}</legend>
              {frozen && <Badge>Goedgekeurd · inhoud staat vast</Badge>}
              <p className={s.muted}>
                Gebaseerd op:{' '}
                {proposal.sourceKeys.map((key) => sources.get(key)?.title || key).join(', ')}
              </p>
              <label className={s.field}>
                <span>Werkomschrijving</span>
                <textarea
                  aria-label={`Werkomschrijving voorstel ${index + 1}`}
                  rows={3}
                  required
                  maxLength={6000}
                  value={proposal.description}
                  onChange={(e) => update({ description: e.target.value })}
                />
              </label>
              <p className={s.muted}>
                Controleer of deze omschrijving de voorgestelde werkzaamheden duidelijk beschrijft.
              </p>
              <div className={s.twoColumns}>
                <Field
                  label={`Locatie voorstel ${index + 1}`}
                  value={proposal.location}
                  maxLength={240}
                  onChange={(e) => update({ location: e.target.value })}
                />
                <label className={s.field}>
                  <span>Urgentie</span>
                  <select
                    aria-label={`Urgentie voorstel ${index + 1}`}
                    value={proposal.urgency}
                    onChange={(e) => update({ urgency: e.target.value as WorkProposal['urgency'] })}
                  >
                    {Object.entries(urgencyLabels).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <details>
                <summary>Aanvullende werkgegevens</summary>
                <div className={s.twoColumns}>
                  <Field
                    label={`Elementcode voorstel ${index + 1}`}
                    maxLength={160}
                    value={proposal.elementCode}
                    onChange={(e) => update({ elementCode: e.target.value })}
                  />
                  <Field
                    label={`Hoeveelheid voorstel ${index + 1}`}
                    type="number"
                    min="0.001"
                    step="any"
                    value={proposal.quantity ?? ''}
                    onChange={(e) =>
                      update({
                        quantity: e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    }
                  />
                  <Field
                    label={`Meeteenheid voorstel ${index + 1}`}
                    maxLength={40}
                    value={proposal.unit}
                    onChange={(e) => update({ unit: e.target.value })}
                  />
                </div>
              </details>
              {!frozen && canWrite && (
                <Button
                  variant="ghost"
                  icon={<Trash2 size={16} />}
                  onClick={() =>
                    change({
                      ...draft,
                      proposals: draft.proposals.filter((item) => item.id !== proposal.id),
                    })
                  }
                >
                  Voorstel verwijderen
                </Button>
              )}
            </fieldset>
          );
        })}
      </section>
      {conflict && (
        <section className={`${s.panel} ${s.stack}`} aria-label="Versieconflict">
          <h3>Een collega heeft de overdracht gewijzigd</h3>
          <p>Je eigen wijzigingen blijven hierboven en op dit apparaat bewaard.</p>
          <Button
            variant="secondary"
            onClick={() =>
              void act(async () => {
                const value = await api<HandoverData>(`${path}/handover`);
                setLatest(value.draft);
                setData(value);
              })
            }
          >
            Nieuwste versie vergelijken
          </Button>
          {latest && (
            <>
              <strong>
                Serverversie {latest.version} · {latest.destination}
              </strong>
              {latest.proposals.map((item) => (
                <p key={item.id}>
                  {item.location}: {item.description}
                </p>
              ))}
              <Button
                variant="secondary"
                onClick={() => {
                  current.current = latest;
                  setDraft(latest);
                  setLatest(undefined);
                  dirtyRef.current = false;
                  setDirty(false);
                  setConflict(false);
                  setSaveError('');
                  void draftRemove(key).catch((e) => setError(errorText(e)));
                }}
              >
                Nieuwste versie overnemen en eigen wijzigingen verwijderen
              </Button>
            </>
          )}
        </section>
      )}
      <section className={`${s.panel} ${s.stack}`} aria-label="Overdracht controleren">
        <h3>Controleren en goedkeuren</h3>
        <p>
          Het volledige definitieve inspectierapport en de goedgekeurde rapportbijlagen worden
          verzonden naar <strong>{destination?.name || 'de gekozen bestemming'}</strong>, samen met{' '}
          {draft.proposals.length} onderhoudsvoorstellen. De selectie hierboven beperkt alleen de
          voorgestelde werkzaamheden.
        </p>
        <p className={s.muted}>
          De ontvangende organisatie beoordeelt en autoriseert de uitvoering. Satvey maakt geen
          onderhoudsorders aan. Na goedkeuring staat de inhoud van deze voorstellen vast;
          aanvullende voorstellen kun je later toevoegen.
        </p>
        {canWrite && (
          <div className={s.actions}>
            <Button
              variant="secondary"
              icon={<Check size={16} />}
              disabled={!dirty || saving || busy || conflict || !valid}
              onClick={() => void save()}
            >
              Wijzigingen opslaan
            </Button>
            <Button
              icon={<Send size={16} />}
              loading={busy}
              disabled={
                dirty ||
                saving ||
                conflict ||
                !valid ||
                !destination?.ready ||
                draft.version < 1 ||
                active ||
                alreadyApproved
              }
              onClick={() =>
                void act(async () => {
                  await api(
                    `${path}/handover/approve`,
                    json('POST', {
                      id: approvalId.current,
                      version: draft.version,
                      destinationId: draft.destinationId,
                    }),
                  );
                  setNotice('Overdracht goedgekeurd. De server verzorgt de verzending.');
                  await load();
                })
              }
            >
              Overdracht goedkeuren
            </Button>
          </div>
        )}
        {alreadyApproved && <p>Deze versie is al goedgekeurd.</p>}
      </section>
      <DeliveryHistory
        deliveries={data.deliveries}
        onRetry={
          canWrite
            ? (id) =>
                void act(async () => {
                  await api(`${path}/handovers/${id}/retry`, json('POST', {}));
                  await load();
                })
            : undefined
        }
      />
    </section>
  );
}
