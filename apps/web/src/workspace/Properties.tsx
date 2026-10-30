import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Dialog, Field } from '../components/ui';
import { api, json } from './api';
import type { Inspection, Property, PropertyPage } from './api';
import { useResource } from './useResource';
import s from './workspace.module.css';
import p from './properties.module.css';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const propertyDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString('nl-NL') : 'Nog niet opgehaald';
export function PropertyFacts({ property }: { property: Partial<Property> }) {
  const facts: [string, string | number | null | undefined][] = [
    ['Objectnummer', property.objectNumber || property.sourceObjectId],
    ['Adres', [property.address, property.postcode, property.city].filter(Boolean).join(', ')],
    ['Bron', [property.sourceName, property.administration].filter(Boolean).join(' · ')],
    ['Bronobject-ID', property.sourceObjectId],
    ['Complex', property.complexName || property.complexId],
    [
      'Clusters',
      property.clusters
        ?.map((c) => [c.name || c.code || c.id, c.kind].filter(Boolean).join(' — '))
        .join(', '),
    ],
    ['Type', property.objectType],
    ['Bouwjaar', property.buildYear],
    [
      'Oppervlakte',
      property.area != null
        ? `${property.area} ${property.areaUnit || ''} · ${property.areaType || ''}`
        : null,
    ],
    [
      'Oppervlaktemetingen',
      property.areas
        ?.map(
          (area) =>
            `${area.value} ${area.unit} · ${area.kind}${area.startDate ? ` · vanaf ${area.startDate}` : ''}${area.endDate ? ` · tot ${area.endDate}` : ''}`,
        )
        .join('; '),
    ],
    ['Status in bron', property.sourceStatus],
    ['BAG-object', property.bagObjectId],
    ['BAG-nummeraanduiding', property.bagAddressId],
    ['BAG-panden', property.bagBuildingIds?.join(', ')],
    ['Opgehaald', property.fetchedAt ? propertyDate(property.fetchedAt) : null],
  ];
  return (
    <dl className={p.facts}>
      {facts
        .filter(([, value]) => value != null && value !== '')
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

export function PropertyPicker({
  base,
  scope,
  selected,
  onSelect,
  state,
  label = 'Zoek woning',
  initialQuery = '',
}: {
  base: string;
  scope: string;
  selected?: string;
  onSelect: (property: Property) => void;
  state?: 'linked' | 'provisional';
  label?: string;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery),
    [search, setSearch] = useState(initialQuery.trim()),
    [page, setPage] = useState(1);
  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const { data, error, cached } = useResource<PropertyPage>(
    scope,
    `${base}/properties?q=${encodeURIComponent(search)}&page=${page}${state ? `&state=${state}` : ''}`,
  );
  return (
    <div className={s.stack}>
      <Field
        label={label}
        placeholder="Objectnummer, straat, postcode of plaats"
        maxLength={240}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && (
        <p role="alert" className={s.error}>
          {cached ? 'Offline: eerder geladen woningen worden getoond.' : error}
        </p>
      )}
      {!data && !error && <p role="status">Woningen laden…</p>}
      {data && (
        <>
          <p className={s.muted} role="status">
            {data.total} {data.total === 1 ? 'woning' : 'woningen'} gevonden
          </p>
          <ul className={p.results} aria-label="Gevonden woningen">
            {data.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={query.trim() !== search}
                  className={`${p.result} ${selected === item.id ? p.selected : ''}`}
                  aria-pressed={selected === item.id}
                  onClick={() => onSelect(item)}
                >
                  <strong>
                    {item.objectNumber ? `${item.objectNumber} · ` : ''}
                    {item.address}
                  </strong>
                  <span>
                    {item.postcode} {item.city}
                    {item.complexName ? ` · ${item.complexName}` : ''}
                  </span>
                  <small>
                    {item.linkState === 'linked'
                      ? `${item.sourceName || 'Bron'} · ${item.sourceStatus || 'Gekoppeld'}`
                      : 'Voorlopig · bronkoppeling nodig'}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          {!data.items.length && (
            <p className={s.muted}>Geen woningen gevonden. Pas je zoekopdracht aan.</p>
          )}
          {data.total > data.pageSize && (
            <div className={s.actions}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Vorige
              </Button>
              <span>
                Pagina {page} van {Math.ceil(data.total / data.pageSize)}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={page * data.pageSize >= data.total}
                onClick={() => setPage(page + 1)}
              >
                Volgende
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function InspectionProperty({
  inspection,
  base,
  scope,
  canWrite,
  canManage,
}: {
  inspection: Inspection;
  base: string;
  scope: string;
  canWrite: boolean;
  canManage: boolean;
}) {
  const snapshot = inspection.propertySnapshot;
  const { data: current } = useResource<Property>(
    scope,
    `${base}/properties/${inspection.propertyId}`,
  );
  const [comparison, setComparison] = useState<Property>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  if (!snapshot) return null;
  const draft = inspection.status === 'draft',
    changed = draft && current && current.revision !== snapshot.revision;
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      await api(`${base}/properties/${inspection.propertyId}/refresh`, json('POST', {}));
      setNotice(
        'Verversen gestart. De inspectiegegevens blijven bewaard totdat je nieuwe gegevens overneemt.',
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function adopt() {
    if (!comparison) return;
    setBusy(true);
    setError('');
    try {
      await api(
        `${base}/inspections/${inspection.id}/property-context`,
        json('POST', {
          contextVersion: inspection.propertyContextVersion,
          propertyRevision: comparison.revision,
        }),
      );
      setComparison(undefined);
      setNotice(
        'Woninggegevens overgenomen. Betrokken beoordelingen moeten opnieuw worden bevestigd.',
      );
      window.dispatchEvent(new Event('satvey-refresh'));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={p.context} aria-label="Woninggegevens bij inspectie">
      {snapshot.linkState !== 'linked' && draft && (
        <p className={s.warning}>
          Deze woning is voorlopig. Een beheerder moet de bronkoppeling bevestigen voordat het
          rapport kan worden vastgelegd.{' '}
          {canManage && <Link to="/app/settings?tab=properties">Woning koppelen</Link>}
        </p>
      )}
      {changed && (
        <div className={s.actions}>
          <p className={s.warning}>Er zijn nieuwe brongegevens beschikbaar.</p>
          {canWrite && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setError('');
                setComparison(current);
              }}
            >
              Brongegevens vergelijken
            </Button>
          )}
        </div>
      )}
      <details>
        <summary>
          Woninggegevens{snapshot.objectNumber ? ` · ${snapshot.objectNumber}` : ''}
        </summary>
        <PropertyFacts property={snapshot} />
        <p className={s.muted}>
          Administratieve gegevens bij deze inspectie. De inspecteur stelt de feitelijke toestand
          vast met inspectiebewijs.
        </p>
        {draft && canWrite && snapshot.sourceKind === 'vera' && (
          <Button variant="secondary" size="sm" loading={busy} onClick={() => void refresh()}>
            Verversen uit bron
          </Button>
        )}
      </details>
      {notice && (
        <p role="status" className={s.muted}>
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      <Dialog
        closeLabel="Sluiten"
        open={!!comparison}
        onOpenChange={(open) => {
          if (!open) setComparison(undefined);
        }}
        title="Brongegevens vergelijken"
        description="Overnemen bewaart een nieuwe inspectiecontext en start heranalyse. Menselijke correcties blijven bewaard; controleer de betrokken beoordelingen opnieuw."
      >
        {comparison && (
          <div className={s.stack}>
            <div className={p.comparison}>
              <section>
                <h3>Gebruikt bij inspectie</h3>
                <PropertyFacts property={snapshot} />
              </section>
              <section>
                <h3>Nieuw uit catalogus</h3>
                <PropertyFacts property={comparison} />
              </section>
            </div>
            {error && (
              <p className={s.error} role="alert">
                {error}
              </p>
            )}
            <Button loading={busy} onClick={() => void adopt()}>
              Gegevens overnemen en herbeoordelen
            </Button>
          </div>
        )}
      </Dialog>
    </section>
  );
}
