import { useEffect, useRef, useState } from 'react';
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
export function PropertyFacts({
  property,
  compact = false,
}: {
  property: Partial<Property>;
  compact?: boolean;
}) {
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
  const render = (entries: typeof facts) => (
    <dl className={p.facts}>
      {entries
        .filter(([, v]) => v != null && v !== '')
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
  const basics = ['Objectnummer', 'Adres', 'Bouwjaar'];
  if (!compact) return render(facts);
  return (
    <>
      {render(facts.filter(([label]) => basics.includes(label)))}
      <details>
        <summary>Meer woninggegevens</summary>
        {render(facts.filter(([label]) => !basics.includes(label)))}
      </details>
    </>
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
  const { data, error, cached, reload } = useResource<PropertyPage>(
    scope,
    `${base}/properties?q=${encodeURIComponent(search)}&page=${page}${state ? `&state=${state}` : ''}`,
  );
  const listKey = `${scope}:${base}:${state}:${search}`;
  const [listing, setListing] = useState<{
    key: string;
    pages: Record<number, Property[]>;
    total: number;
    pageSize: number;
    loaded: boolean;
  }>({ key: listKey, pages: {}, total: 0, pageSize: 25, loaded: false });
  const sentinel = useRef<HTMLLIElement>(null),
    results = useRef<HTMLUListElement>(null);
  useEffect(() => {
    setPage(1);
    results.current?.scrollTo(0, 0);
  }, [listKey]);
  const received = useRef<PropertyPage | undefined>(undefined);
  useEffect(() => {
    if (data && data !== received.current) {
      received.current = data;
      setListing((old) => ({
        key: listKey,
        pages: { ...(old.key === listKey ? old.pages : {}), [data.page]: data.items },
        total: data.total,
        pageSize: data.pageSize,
        loaded: true,
      }));
    }
  }, [data, listKey]);
  const metadata = listing.key === listKey && listing.loaded ? listing : undefined;

  const items =
    listing.key === listKey
      ? [
          ...new Map(
            Object.keys(listing.pages)
              .map(Number)
              .sort((a, b) => a - b)
              .flatMap((n) => listing.pages[n])
              .map((item) => [item.id, item]),
          ).values(),
        ]
      : [];
  const more = !!data && data.page === page && page * data.pageSize < data.total;
  useEffect(() => {
    if (!sentinel.current || !more || error) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setPage((n) => n + 1);
      },
      { root: results.current, rootMargin: '120px' },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [more, page, error, metadata]);
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
      {!metadata && !error && <p role="status">Woningen laden…</p>}
      {metadata && (
        <>
          <p className={s.muted} role="status">
            {metadata.total} {metadata.total === 1 ? 'woning' : 'woningen'} gevonden
          </p>
          <ul ref={results} className={p.results} aria-label="Gevonden woningen">
            {items.map((item) => (
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
            <li ref={sentinel} aria-hidden="true" style={{ minHeight: 1 }} />
          </ul>
          {!items.length && (
            <p className={s.muted}>Geen woningen gevonden. Pas je zoekopdracht aan.</p>
          )}
          {(more || (!data && items.length > 0)) && (
            <p role="status" className={s.muted}>
              Meer woningen laden tijdens scrollen…
            </p>
          )}
          {!more && !!data && items.length > 0 && (
            <p className={s.muted}>Alle gevonden woningen geladen.</p>
          )}
          {error && (
            <Button variant="secondary" onClick={reload}>
              Opnieuw proberen
            </Button>
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
