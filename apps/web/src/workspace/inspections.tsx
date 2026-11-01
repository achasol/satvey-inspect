import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ChevronRight, House, Plus } from 'lucide-react';
import { Badge, Button, Dialog, Field } from '../components/ui';
import { api, json, uuid } from './api';
import type { InspectionFormat, Dossier, Inspection, Organisation, Property } from './api';
import { ArchiveInspection as DeleteInspection } from './DossierActions';
import { useResource } from './useResource';
import { PropertyFacts, PropertyPicker } from './Properties';
import s from './workspace.module.css';
import {
  errorText,
  kindLabel,
  dateLabel,
  announceRefresh,
  ErrorNotice,
  Loading,
  Select,
} from './shared';

export const propertyIconTones = [
  'propertyOlive',
  'propertyBlue',
  'propertyTerracotta',
  'propertyAmber',
  'propertyPlum',
  'propertyTeal',
] as const;

export function propertyIconTone(propertyId: string) {
  let hash = 0;
  for (const char of propertyId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return s[propertyIconTones[hash % propertyIconTones.length]];
}

export function InspectionList({
  base,

  scope,

  canWrite,
  org,
}: {
  base: string;

  scope: string;

  canWrite: boolean;
  org: Organisation;
}) {
  const [create, setCreate] = useState(false),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(0),
    [view, setView] = useState('all');
  const {
    data: inspectionPage,
    error,
    cached,
  } = useResource<{ items: Inspection[]; total: number; open: number }>(
    scope,
    `${base}/inspection-page?limit=50&offset=${page * 50}&q=${encodeURIComponent(query)}&view=${view}`,
  );

  const data = inspectionPage?.items,
    archived = view === 'archived';
  return (
    <>
      <div className={s.pageHeading}>
        <div>
          <h1>Inspecties</h1>

          <p className={s.muted}>
            {inspectionPage?.open || 0} openstaand - {inspectionPage?.total || 0} gevonden
          </p>
        </div>

        {canWrite && (
          <Button icon={<Plus size={18} />} onClick={() => setCreate(true)}>
            Inspectie toevoegen
          </Button>
        )}
      </div>

      {error && <ErrorNotice>{cached ? 'Offline: laatst geladen inspecties.' : error}</ErrorNotice>}

      <div className={s.listToolbar}>
        <Select
          label="Dossiers"
          value={view}
          onChange={(v) => {
            setView(v);
            setPage(0);
          }}
        >
          {Object.entries({
            all: 'Alle actieve dossiers',
            mine: 'Mijn inspecties',
            today: 'Vandaag',
            overdue: 'Te laat',
            unassigned: 'Niet toegewezen',
            review: 'Kwaliteitscontrole',
            delivery: 'Overdrachtsproblemen',
            archived: 'Gearchiveerd',
          }).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <div className={s.search}>
          <Field
            label="Inspecties zoeken"
            placeholder="Adres, postcode, objectnummer of plaats"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </div>
      </div>
      {!data ? (
        <Loading />
      ) : !data.length ? (
        <section className={s.empty}>
          <House size={34} />

          <h2>
            {query
              ? 'Geen resultaten'
              : archived
                ? 'Geen gearchiveerde dossiers'
                : 'Nog geen inspecties'}
          </h2>

          {canWrite && <Button onClick={() => setCreate(true)}>Eerste inspectie toevoegen</Button>}
        </section>
      ) : (
        <div className={s.inspectionList}>
          {data.map((i) => (
            <div key={i.id} className={s.inspectionItem}>
              <Link
                to={`/app/inspections/${i.id}/${i.status === 'final' ? 'report' : 'capture'}`}
                className={`${s.inspectionRow} ${canWrite ? s.inspectionRowWithActions : ''}`}
              >
                <span className={`${s.propertyIcon} ${propertyIconTone(i.propertyId)}`}>
                  <House size={23} />
                </span>

                <span className={s.rowAddress}>
                  <strong>{i.address}</strong>

                  <span>
                    {i.postcode} {i.city}
                  </span>
                </span>

                <span className={s.rowDate}>
                  {kindLabel(i.kind)}

                  <small>{dateLabel(i.scheduledAt)}</small>
                </span>

                <Badge tone={i.status === 'final' ? 'success' : 'neutral'}>
                  {i.status === 'final' ? 'Vastgelegd' : 'Open'}
                </Badge>

                <ChevronRight size={19} />
              </Link>
              {canWrite && (
                <div className={s.inspectionDeleteAction}>
                  <DeleteInspection
                    base={base}
                    scope={scope}
                    inspection={i}
                    iconOnly
                    canManage={org.privileges.includes('inspections.archive')}
                    canPurge={org.privileges.includes('inspections.purge')}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <nav aria-label="Inspectiepagina's" className={s.actions}>
        <Button variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          Vorige pagina
        </Button>
        <span>Pagina {page + 1}</span>
        <Button
          variant="secondary"
          disabled={!inspectionPage || (page + 1) * 50 >= inspectionPage.total}
          onClick={() => setPage((p) => p + 1)}
        >
          Volgende pagina
        </Button>
      </nav>
      {create && <NewInspection base={base} scope={scope} onClose={() => setCreate(false)} />}
    </>
  );
}

export { ArchiveInspection as DeleteInspection } from './DossierActions';

export function NewInspection({
  base,
  scope,
  onClose,
}: {
  base: string;
  scope: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1),
    [formats, setFormats] = useState<InspectionFormat[]>([]),
    [formatVersionId, setFormatVersionId] = useState(''),
    [formatReady, setFormatReady] = useState(false),
    [formatError, setFormatError] = useState('');
  const [propertyChoice, setPropertyChoice] = useState(''),
    [chosenProperty, setChosenProperty] = useState<Property>(),
    [address, setAddress] = useState(''),
    [city, setCity] = useState(''),
    [postcode, setPostcode] = useState(''),
    [scheduled, setScheduled] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const ids = useRef({ property: uuid(), inspection: uuid() }),
    propertyQuery = useRef(''),
    stepHeading = useRef<HTMLHeadingElement>(null),
    selectedFormat = formats.find((f) => f.id === formatVersionId),
    newProperty = propertyChoice === 'new',
    propertyReady = newProperty ? !!address.trim() : !!chosenProperty;
  function selectProperty(property: Property) {
    setPropertyChoice(property.id);
    setChosenProperty(property);
    setError('');
    setStep(2);
  }
  useEffect(() => {
    stepHeading.current?.focus();
    stepHeading.current?.scrollIntoView({ block: 'nearest' });
  }, [step]);
  useEffect(() => {
    void api<InspectionFormat[]>(`${base}/formats`)
      .then((all) => {
        // Older published revisions remain selectable, with the latest revision first.
        const published = all.filter((f) => f.status === 'published');
        setFormats(published);
        setFormatVersionId(published.find((f) => f.kind === 'pre')?.id || published[0]?.id || '');
      })
      .catch((e) => setFormatError(errorText(e)))
      .finally(() => setFormatReady(true));
  }, [base]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (step === 1 && !newProperty) return;
    setError('');
    if (!propertyReady) {
      setError('Kies een woning uit de catalogus of vul het adres van een voorlopige woning in.');
      return;
    }
    if (step === 1) {
      setStep(2);
      return;
    }
    if (!selectedFormat) {
      setError('Kies een gepubliceerd inspectiesjabloon.');
      return;
    }
    setBusy(true);
    try {
      const propertyId = newProperty ? ids.current.property : propertyChoice;
      if (newProperty)
        await api(`${base}/properties`, json('POST', { id: propertyId, address, city, postcode }));
      await api(
        `${base}/inspections`,
        json('POST', {
          id: ids.current.inspection,
          propertyId,
          formatVersionId: selectedFormat.id,
          kind: selectedFormat.kind,
          scheduledAt: scheduled ? new Date(scheduled).toISOString() : null,
        }),
      );
      onClose();
      navigate(`/app/inspections/${ids.current.inspection}/capture`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title="Inspectie toevoegen"
      description={`Stap ${step} van 2 ? ${step === 1 ? 'Woning kiezen' : 'Inspectiesjabloon kiezen'}`}
      closeLabel="Sluiten"
      fullOnMobile
    >
      <form onSubmit={submit} className={s.stack}>
        <ol className={s.creationSteps} aria-label="Stappen inspectie aanmaken">
          <li aria-current={step === 1 ? 'step' : undefined}>
            <span>1</span> Woning
          </li>
          <li aria-current={step === 2 ? 'step' : undefined}>
            <span>2</span> Format
          </li>
        </ol>
        <h3 ref={stepHeading} tabIndex={-1}>
          {step === 1 ? 'Woning kiezen' : 'Woning en inspectiesjabloon'}
        </h3>
        {step === 1 ? (
          <>
            {!newProperty ? (
              <>
                <PropertyPicker
                  base={base}
                  scope={scope}
                  selected={propertyChoice}
                  initialQuery={propertyQuery.current}
                  onSelect={selectProperty}
                />
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    propertyQuery.current = '';
                    setPropertyChoice('new');
                    setChosenProperty(undefined);
                  }}
                >
                  Woning niet gevonden? Voorlopige woning aanmaken
                </Button>
              </>
            ) : (
              <>
                <p className={s.warning}>
                  Je kunt direct opnemen. Een beheerder moet de bronkoppeling bevestigen voordat het
                  rapport kan worden vastgelegd.
                </p>
                <Button type="button" variant="ghost" onClick={() => setPropertyChoice('')}>
                  Terug naar woningcatalogus
                </Button>
                <Field
                  label="Adres"
                  placeholder="Straat en huisnummer"
                  autoComplete="street-address"
                  required
                  maxLength={240}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
                <details>
                  <summary>Adresdetails (optioneel)</summary>
                  <div className={s.twoColumns} style={{ paddingTop: 14 }}>
                    <Field
                      label="Postcode"
                      autoComplete="postal-code"
                      maxLength={20}
                      value={postcode}
                      onChange={(e) => setPostcode(e.target.value)}
                    />
                    <Field
                      label="Plaats"
                      autoComplete="address-level2"
                      maxLength={120}
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                    />
                  </div>
                </details>
                {address.trim().length >= 3 && (
                  <details open>
                    <summary>Controleer mogelijke bestaande woningen</summary>
                    <PropertyPicker
                      base={base}
                      scope={scope}
                      initialQuery={address}
                      label="Zoek mogelijke bestaande woning"
                      onSelect={selectProperty}
                    />
                  </details>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <section aria-label="Gekozen woning">
              <h3>Gekozen woning</h3>
              <PropertyFacts
                compact
                property={newProperty ? { address, postcode, city } : chosenProperty!}
              />
              {(newProperty || chosenProperty?.linkState === 'provisional') && (
                <p className={s.warning}>
                  Een beheerder moet deze woning v??r het vastleggen aan een bronobject koppelen.
                </p>
              )}
            </section>
            <Select label="Inspectiesjabloon" value={formatVersionId} onChange={setFormatVersionId}>
              <option value="">Kies een gepubliceerd format</option>
              {(['pre', 'final'] as const).map((kind) => (
                <optgroup key={kind} label={kindLabel(kind)}>
                  {formats
                    .filter((f) => f.kind === kind)
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name} - versie {f.number}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
            {selectedFormat && <p className={s.muted}>{kindLabel(selectedFormat.kind)}</p>}
            {!formatReady && <p role="status">Inspectiesjablonen laden?</p>}
            {formatError && <ErrorNotice>{formatError}</ErrorNotice>}
            {formatReady && !formatError && !formats.length && (
              <p className={s.warning}>
                Laat kwaliteitsbeheer eerst een inspectiesjabloon publiceren.{' '}
                <Link to="/app/formats" onClick={onClose}>
                  Inspectiesjablonen openen
                </Link>
              </p>
            )}
            <details>
              <summary>Gepland bezoek (optioneel)</summary>
              <p className={s.muted}>
                Leg het geplande bezoek vast. Er wordt geen uitnodiging verstuurd.
              </p>
              <div style={{ paddingTop: 14 }}>
                <Field
                  label="Gepland bezoek"
                  type="datetime-local"
                  value={scheduled}
                  onChange={(e) => setScheduled(e.target.value)}
                />
              </div>
            </details>
          </>
        )}
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <div className={s.actions}>
          {step === 2 && (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                propertyQuery.current =
                  chosenProperty?.objectNumber || chosenProperty?.address || '';
                setError('');
                setStep(1);
              }}
            >
              <ArrowLeft size={16} /> Vorige
            </Button>
          )}
          {step === 1 ? (
            newProperty && (
              <Button key="next" type="submit" disabled={!propertyReady}>
                Deze woning gebruiken <ArrowRight size={16} />
              </Button>
            )
          ) : (
            <Button
              key="create"
              type="submit"
              loading={busy}
              disabled={!formatReady || !selectedFormat || !propertyReady}
            >
              Aanmaken <ArrowRight size={16} />
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

export function AddRoom({
  path,
  data,
  onAdded,
}: {
  path: string;
  data: Dossier;
  onAdded?: (id: string) => void;
}) {
  const available = data.format?.scopes.filter((category) => !category.property) || [];
  const [open, setOpen] = useState(false),
    [categoryId, setCategoryId] = useState(''),
    [name, setName] = useState(''),
    [nameEdited, setNameEdited] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const category = available.find((category) => category.id === categoryId);
  function suggestedName(id: string) {
    const category = available.find((category) => category.id === id);
    if (!category) return '';
    const base = category.name.replace(/\s+\d+$/, '').trim();
    let number = data.rooms.filter((room) => room.categoryId === id).length + 1;
    const used = new Set(data.rooms.map((room) => room.name.trim().toLocaleLowerCase('nl-NL')));
    while (used.has(`${base} ${number}`.toLocaleLowerCase('nl-NL'))) number++;
    return `${base} ${number}`;
  }
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={<Plus size={15} />}
        disabled={!!data.format && !available.length}
        onClick={() => {
          const initial = available[0]?.id || '';
          setCategoryId(initial);
          setName(suggestedName(initial));
          setNameEdited(false);
          setError('');
          setOpen(true);
        }}
      >
        Ruimte toevoegen
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
        title="Ruimte toevoegen"
        description="Kies het ruimtetype en geef de ruimte een naam."
        closeLabel="Sluiten"
      >
        <form
          className={s.stack}
          onSubmit={async (event) => {
            event.preventDefault();
            if (!name.trim() || (data.format && !category)) return;
            setError('');
            setBusy(true);
            try {
              const id = uuid();
              await api(`${path}/rooms`, json('POST', { id, name: name.trim(), categoryId }));
              setOpen(false);
              onAdded?.(id);
              announceRefresh();
            } catch (error) {
              setError(errorText(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          {data.format && (
            <Select
              label="Ruimtetype"
              value={categoryId}
              onChange={(value) => {
                setCategoryId(value);
                if (!nameEdited) setName(suggestedName(value));
              }}
            >
              {available.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          )}
          <Field
            label="Ruimtenaam"
            required
            maxLength={100}
            value={name}
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
              setNameEdited(true);
            }}
          />
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <div className={s.actions}>
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              Annuleren
            </Button>
            <Button
              type="submit"
              loading={busy}
              disabled={!name.trim() || (!!data.format && !category)}
            >
              Toevoegen
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
