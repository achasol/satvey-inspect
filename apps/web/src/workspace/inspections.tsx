import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ChevronRight, House, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Dialog, Field } from '../components/ui';
import { api, ApiError, json, uuid } from './api';
import type { InspectionFormat, Dossier, Inspection, Property } from './api';
import { forgetInspection } from './outbox';
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
}: {
  base: string;

  scope: string;

  canWrite: boolean;
}) {
  const [create, setCreate] = useState(false),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(0);
  const { data, error, cached } = useResource<Inspection[]>(
    scope,
    `${base}/inspections?limit=50&offset=${page * 50}&q=${encodeURIComponent(query)}`,
  );

  return (
    <>
      <div className={s.pageHeading}>
        <div>
          <h1>Inspecties</h1>

          <p className={s.muted}>
            {data?.filter((i) => i.status === 'draft').length || 0} openstaand op deze pagina
          </p>
        </div>

        {canWrite && (
          <Button icon={<Plus size={18} />} onClick={() => setCreate(true)}>
            Inspectie toevoegen
          </Button>
        )}
      </div>

      {error && <ErrorNotice>{cached ? 'Offline: laatst geladen inspecties.' : error}</ErrorNotice>}

      <div className={s.search}>
        <Field
          label="Inspecties zoeken"
          placeholder="Zoek op adres of plaats"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
      </div>

      {!data ? (
        <Loading />
      ) : !data.length ? (
        <section className={s.empty}>
          <House size={34} />

          <h2>Nog geen inspecties</h2>

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
                  <DeleteInspection base={base} scope={scope} inspection={i} iconOnly />
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
          disabled={!data || data.length < 50}
          onClick={() => setPage((p) => p + 1)}
        >
          Volgende pagina
        </Button>
      </nav>
      {create && <NewInspection base={base} scope={scope} onClose={() => setCreate(false)} />}
    </>
  );
}

export function DeleteInspection({
  base,
  scope,
  inspection,
  iconOnly = false,
  onDeleted,
}: {
  base: string;
  scope: string;
  inspection: Inspection;
  iconOnly?: boolean;
  onDeleted?: () => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function remove() {
    setBusy(true);
    setError('');
    const path = `${base}/inspections/${inspection.id}`;
    try {
      if (!navigator.onLine)
        throw new Error('Maak verbinding met internet om de inspectie te verwijderen.');
      let observationIds: string[] = [];
      try {
        const dossier = await api<Dossier>(path);
        observationIds = dossier.observations.map((o) => o.id);
        await api(path, { method: 'DELETE' });
      } catch (e) {
        // A retry after a lost response may find an already deleted dossier.
        if (!(e instanceof ApiError) || e.status !== 404) throw e;
      }
      await forgetInspection(scope, path, inspection.id, observationIds);
      setOpen(false);
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
        icon={<Trash2 size={17} />}
        aria-label={iconOnly ? `Inspectie verwijderen: ${inspection.address}` : undefined}
        title={iconOnly ? 'Inspectie verwijderen' : undefined}
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        {!iconOnly && 'Inspectie verwijderen'}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
        title="Inspectie verwijderen"
        description={`${kindLabel(inspection.kind)} · ${inspection.address}`}
        closeLabel="Sluiten"
      >
        <div className={s.stack}>
          <p>
            Deze inspectie, alle opnamen, beoordelingen en het eventuele rapport worden definitief
            verwijderd. Ook lokale concepten op dit apparaat worden verwijderd. De woning blijft
            beschikbaar voor nieuwe inspecties.
          </p>
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <div className={s.actions}>
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              Annuleren
            </Button>
            <Button variant="destructive" loading={busy} onClick={() => void remove()}>
              Definitief verwijderen
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

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
      setError('Kies een gepubliceerd inspectieformat.');
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
      description={`Stap ${step} van 2 ? ${step === 1 ? 'Woning kiezen' : 'Format kiezen'}`}
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
          {step === 1 ? 'Woning kiezen' : 'Woning en inspectieformat'}
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
                  Voorlopige woning aanmaken
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
                property={newProperty ? { address, postcode, city } : chosenProperty!}
              />
              {(newProperty || chosenProperty?.linkState === 'provisional') && (
                <p className={s.warning}>
                  Een beheerder moet deze woning v??r het vastleggen aan een bronobject koppelen.
                </p>
              )}
            </section>
            <Select label="Inspectieformat" value={formatVersionId} onChange={setFormatVersionId}>
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
            {!formatReady && <p role="status">Inspectieformats laden?</p>}
            {formatError && <ErrorNotice>{formatError}</ErrorNotice>}
            {formatReady && !formatError && !formats.length && (
              <p className={s.warning}>
                Laat kwaliteitsbeheer eerst een inspectieformat publiceren.{' '}
                <Link to="/app/formats" onClick={onClose}>
                  Inspectieformats openen
                </Link>
              </p>
            )}
            <details>
              <summary>Afspraak toevoegen (optioneel)</summary>
              <div style={{ paddingTop: 14 }}>
                <Field
                  label="Afspraak (optioneel)"
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
              <ArrowLeft size={16} /> Vorige stap
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
              Aanmaken en opnemen <ArrowRight size={16} />
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

export function AddRoom({ path, data }: { path: string; data: Dossier }) {
  const available =
    data.format?.scopes.filter(
      (c) => !c.property && (c.repeatable || !data.rooms.some((r) => r.categoryId === c.id)),
    ) || [];
  const [open, setOpen] = useState(false),
    [categoryId, setCategoryId] = useState(''),
    [customName, setCustomName] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const category = available.find((c) => c.id === categoryId),
    count = data.rooms.filter((r) => r.categoryId === categoryId).length;
  const suggestedName = category ? (count ? `${category.name} ${count + 1}` : category.name) : '',
    name = customName.trim() || suggestedName;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={<Plus size={15} />}
        onClick={() => {
          setCategoryId(available.length === 1 ? available[0].id : '');
          setCustomName('');
          setOpen((v) => !v);
        }}
      >
        Ruimte toevoegen
      </Button>
      {open && (
        <form
          className={s.stack}
          onSubmit={async (e) => {
            e.preventDefault();
            setError('');
            setBusy(true);
            try {
              await api(`${path}/rooms`, json('POST', { id: uuid(), name, categoryId }));
              announceRefresh();
              setOpen(false);
              setCustomName('');
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {data.format ? (
            available.length > 1 ? (
              <Select
                label="Ruimtecategorie"
                value={categoryId}
                onChange={(v) => {
                  setCategoryId(v);
                  setCustomName('');
                }}
              >
                <option value="">Kies een categorie</option>
                {available.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            ) : available.length === 1 ? (
              <p>{suggestedName}</p>
            ) : (
              <p className={s.muted}>Alle beschikbare ruimtes zijn toegevoegd.</p>
            )
          ) : null}
          {data.format ? (
            <details>
              <summary>Naam aanpassen</summary>
              <Field
                label="Ruimtenaam"
                maxLength={100}
                placeholder={suggestedName}
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
              />
            </details>
          ) : (
            <Field
              label="Ruimtenaam"
              required
              maxLength={100}
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
            />
          )}
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <Button
            size="sm"
            type="submit"
            loading={busy}
            disabled={!name || (!!data.format && !category)}
          >
            {name ? `${name} toevoegen` : 'Toevoegen'}
          </Button>
        </form>
      )}
    </>
  );
}
