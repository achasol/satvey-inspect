import { useState } from 'react';
import { Box, Plus } from 'lucide-react';
import { Badge, Button, Checkbox, Dialog, Field } from '../components/ui';
import { api, can, json } from './api';
import type { Organisation, RoomElement } from './api';
import { useResource } from './useResource';
import s from './workspace.module.css';

const defaultRooms = [
  'Entree',
  'Woonkamer',
  'Keuken',
  'Badkamer',
  'Toilet',
  'Slaapkamer',
  'Buitenruimte',
];
export function ElementsModule({
  base,
  scope,
  org,
}: {
  base: string;
  scope: string;
  org: Organisation;
}) {
  const { data, error, reload } = useResource<RoomElement[]>(scope, `${base}/elements`);
  const [room, setRoom] = useState(''),
    [query, setQuery] = useState(''),
    [editing, setEditing] = useState<RoomElement | null | undefined>(),
    [archived, setArchived] = useState(false);
  const rooms = Array.from(
    new Set([...defaultRooms, ...(data || []).flatMap((e) => e.rooms).filter((r) => r !== '*')]),
  ).sort();
  const elements = (data || []).filter(
    (e) =>
      e.archived === archived &&
      (!room || e.rooms.includes('*') || e.rooms.includes(room)) &&
      `${e.name} ${e.aliases.join(' ')}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className={s.stack} aria-label="Ruimtes en elementen">
      <div className={s.pageHeading}>
        <div>
          <h2>Ruimtes en elementen</h2>
          <p className={s.muted}>
            Beschrijf welke onderdelen bij een ruimte horen en wat de AI moet herkennen.
          </p>
        </div>
        {can(org, 'norms.manage') && (
          <Button icon={<Plus size={17} />} onClick={() => setEditing(null)}>
            Element toevoegen
          </Button>
        )}
      </div>
      <div className={s.twoColumns}>
        <Field
          label="Element zoeken"
          placeholder="Bijvoorbeeld kraan of wand"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className={s.field}>
          <span>Ruimte filteren</span>
          <select
            aria-label="Ruimte filteren"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
          >
            <option value="">Alle ruimtes</option>
            {rooms.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
      </div>
      <Checkbox
        label="Gearchiveerde elementen tonen"
        checked={archived}
        onCheckedChange={setArchived}
      />
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      <div className={s.elementGrid}>
        {elements.map((e) => (
          <article key={e.id} className={s.panel}>
            <div className={s.actions}>
              <Box size={20} />
              <h3>{e.name}</h3>
              {e.archived && <Badge>Gearchiveerd</Badge>}
            </div>
            <div className={s.actions}>
              {e.rooms.map((r) => (
                <Badge key={r}>{r === '*' ? 'Alle ruimtes' : r}</Badge>
              ))}
            </div>
            <p>{e.description}</p>
            {e.aliases.length > 0 && <p className={s.muted}>Ook: {e.aliases.join(', ')}</p>}
            <p>
              <strong>AI-aandachtspunten</strong>
              <br />
              {e.aiGuidance || 'Nog niet ingevuld'}
            </p>
            {can(org, 'norms.manage') && (
              <Button variant="secondary" size="sm" onClick={() => setEditing(e)}>
                Element bewerken
              </Button>
            )}
          </article>
        ))}
      </div>
      {data && !elements.length && (
        <p className={s.emptySmall}>Geen elementen voor deze selectie.</p>
      )}
      <p className={s.muted}>
        Een element is context, geen bewijs dat het aanwezig is. Nieuwe inspecties bewaren een kopie
        van deze definities; bestaande inspecties behouden hun context.
      </p>
      {editing !== undefined && (
        <ElementEditor
          key={editing?.id || 'new'}
          base={base}
          element={editing}
          rooms={rooms}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            reload();
            window.dispatchEvent(new Event('satvey-refresh'));
          }}
        />
      )}
    </section>
  );
}
function ElementEditor({
  base,
  element,
  rooms,
  onClose,
  onSaved,
}: {
  base: string;
  element: RoomElement | null;
  rooms: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(element?.name || ''),
    [description, setDescription] = useState(element?.description || ''),
    [guidance, setGuidance] = useState(element?.aiGuidance || ''),
    [aliases, setAliases] = useState(element?.aliases.join(', ') || ''),
    [selected, setSelected] = useState(element?.rooms || []),
    [custom, setCustom] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function save(archived: boolean) {
    setBusy(true);
    setError('');
    try {
      await api(
        element ? `${base}/elements/${element.id}` : `${base}/elements`,
        json(element ? 'PUT' : 'POST', {
          name,
          description,
          aiGuidance: guidance,
          rooms: selected,
          aliases: aliases
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean),
          archived,
          version: element?.version || 0,
        }),
      );
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Opslaan mislukt');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={element ? 'Element bewerken' : 'Element toevoegen'}
      description="Geef het onderdeel een herkenbare naam en koppel het aan ruimtes."
      closeLabel="Sluiten"
      fullOnMobile
    >
      <form
        className={s.stack}
        onSubmit={(e) => {
          e.preventDefault();
          void save(element?.archived || false);
        }}
      >
        <Field
          label="Naam element"
          required
          maxLength={120}
          placeholder="Bijvoorbeeld kraan"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className={s.field}>
          <span>Wat is dit element?</span>
          <textarea
            aria-label="Wat is dit element?"
            rows={2}
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <fieldset className={s.privilegeGroup}>
          <legend>Onderdeel van welke ruimtes?</legend>
          <Checkbox
            label="Alle ruimtes"
            checked={selected.includes('*')}
            onCheckedChange={(v) => setSelected(v ? ['*'] : [])}
          />
          <div className={s.roomChecks}>
            {Array.from(new Set([...rooms, ...selected.filter((r) => r !== '*')])).map((r) => (
              <Checkbox
                key={r}
                label={r}
                checked={selected.includes('*') || selected.includes(r)}
                disabled={selected.includes('*')}
                onCheckedChange={(v) =>
                  setSelected((current) => (v ? [...current, r] : current.filter((x) => x !== r)))
                }
              />
            ))}
          </div>
          <div className={s.actions}>
            <Field
              label="Andere ruimte"
              value={custom}
              maxLength={100}
              onChange={(e) => setCustom(e.target.value)}
            />
            <Button
              variant="secondary"
              type="button"
              disabled={!custom.trim() || selected.includes('*')}
              onClick={() => {
                const next = custom.trim();
                if (next && !selected.includes(next)) setSelected([...selected, next]);
                setCustom('');
              }}
            >
              Ruimte koppelen
            </Button>
          </div>
        </fieldset>
        <label className={s.field}>
          <span>Waar moet de AI op letten?</span>
          <textarea
            aria-label="Waar moet de AI bij dit element op letten?"
            rows={3}
            maxLength={3000}
            placeholder="Bijvoorbeeld: zichtbare beschadiging en lekkage bij aansluitingen. Werking kan alleen na een beschreven test worden beoordeeld."
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
          />
        </label>
        <Field
          label="Andere benamingen (optioneel)"
          placeholder="Mengkraan, faucet"
          maxLength={1000}
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
        />
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        <div className={s.actions}>
          <Button type="submit" loading={busy} disabled={!selected.length}>
            Element opslaan
          </Button>
          {element && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    element.archived
                      ? 'Dit element weer beschikbaar maken voor nieuwe inspecties?'
                      : 'Dit element archiveren? Bestaande inspecties behouden hun context.',
                  )
                )
                  void save(!element.archived);
              }}
            >
              {element.archived ? 'Element herstellen' : 'Element archiveren'}
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
