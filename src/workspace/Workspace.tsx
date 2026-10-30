import { useCallback, useEffect, useRef, useState } from 'react';

import type { FormEvent, ReactNode } from 'react';

import { Link, useLocation, useNavigate } from 'react-router-dom';

import {
  BookOpen,
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CheckCheck,
  ChevronRight,
  ClipboardList,
  Download,
  House,
  LogOut,
  Mic,
  Plus,
  RefreshCw,
  Settings,
  Square,
  Trash2,
  Upload,
  WifiOff,
  X,
} from 'lucide-react';

import { Badge, BrandMark, Button, Dialog, Field } from '../components/ui';

import { api, ApiError, can, json, mediaURL, reportPDF, uuid } from './api';

import type {
  InspectionFormat,
  Account,
  Batch,
  Dossier,
  Inspection,
  Media,
  Observation,
  Organisation,
  Property,
  Report,
  SignatureInput,
} from './api';

import {
  actions,
  draftGet,
  draftPut,
  draftRemove,
  forgetInspection,
  pendingDraftCount,
  enqueueEdit,
  removeAction,
  saveAction,
  setScope,
  sync,
  useOutbox,
} from './outbox';

import type { Action, LocalMedia } from './outbox';

import { useResource } from './useResource';

import { NormsModule, outcomeLabels } from './Norms';

import { FormatsModule } from './Formats';
import { ReportSignatures, SignaturesEditor } from './Signatures';

import { TalkingGuide, FormatRoomReview, FormatReportResults } from './FormatReview';

import { SettingsView } from './Settings';
import { InspectionProperty, PropertyFacts, PropertyPicker } from './Properties';

import { TranscriptEditor, NormAssessmentReview } from './NormReview';

import { PhotoTile } from './PhotoViewer';
import { CameraSession } from './CameraSession';
import s from './workspace.module.css';

const errorText = (e: unknown) =>
  e instanceof Error ? e.message : 'Er ging iets mis. Probeer opnieuw.';

const kindLabel = (kind: string) => (kind === 'pre' ? 'Voorinspectie' : 'Eindinspectie');

const dateLabel = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('nl-NL', {
        day: 'numeric',

        month: 'short',

        hour: '2-digit',

        minute: '2-digit',
      })
    : 'Niet ingepland';

const announceRefresh = () => window.dispatchEvent(new Event('satvey-refresh'));

function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <p className={s.error} role="alert">
      {children}
    </p>
  );
}

function Loading() {
  return (
    <p className={s.loading} role="status">
      Laden…
    </p>
  );
}

function Select({
  label,

  value,

  onChange,

  children,
}: {
  label: string;

  value: string;

  onChange: (s: string) => void;

  children: ReactNode;
}) {
  return (
    <label className={s.field}>
      <span>{label}</span>

      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [passwordStep, setPasswordStep] = useState(false);

  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);

  const linkSSO = new URLSearchParams(window.location.search).get('link_sso') === '1';

  useEffect(() => {
    if (linkSSO)
      void api<{ email: string }>('/auth/oidc/link')
        .then((value) => {
          setEmail(value.email);

          setPasswordStep(true);
        })

        .catch((e) => setError(errorText(e)));
  }, [linkSSO]);

  async function login(e: FormEvent) {
    e.preventDefault();

    setBusy(true);

    setError('');

    try {
      if (linkSSO) {
        await api('/auth/oidc/link', json('POST', { password }));

        window.history.replaceState(null, '', '/app');

        onLogin();
      } else if (!passwordStep) {
        const result = await api<{ method: string; url?: string }>(
          '/auth/discover',

          json('POST', { email }),
        );

        if (result.method === 'sso' && result.url) {
          window.location.assign(result.url);

          return;
        }

        setPasswordStep(true);
      } else {
        await api('/auth/login', json('POST', { email, password }));

        onLogin();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={s.login}>
      <div className={s.loginBrand}>
        <BrandMark size={34} />

        <strong>satvey.</strong>
      </div>

      <section className={s.loginPanel}>
        <h1>Inloggen</h1>

        <form onSubmit={login} className={s.stack}>
          {linkSSO && (
            <p className={s.muted}>
              Je SSO-aanmelding is bevestigd. Vul één keer je bestaande wachtwoord in om beide
              aanmeldmethoden aan dit account te koppelen.
            </p>
          )}

          <Field
            label="E-mailadres"
            type="email"
            autoComplete="username"
            readOnly={linkSSO}
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);

              setPasswordStep(false);

              setPassword('');

              setError('');
            }}
          />

          {passwordStep && (
            <Field
              label="Wachtwoord"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}

          {error && <ErrorNotice>{error}</ErrorNotice>}

          <Button type="submit" loading={busy}>
            {passwordStep ? 'Inloggen' : 'Doorgaan'}

            {!passwordStep && <ArrowRight size={16} />}
          </Button>
        </form>
      </section>
    </main>
  );
}

function Invitation({ account, onDone }: { account: Account | null; onDone: () => void }) {
  const token = new URLSearchParams(window.location.search).get('token') || '';

  const [info, setInfo] = useState<{ email: string; organisation: string; role: string }>(),
    [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState('');

  useEffect(() => {
    void api<typeof info>(`/invitations/${token}`)
      .then(setInfo)

      .catch((e) => setError(errorText(e)));
  }, [token]);

  async function accept(e: FormEvent) {
    e.preventDefault();

    try {
      await api('/invitations/accept', json('POST', { token, name, password }));

      onDone();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <main className={s.login}>
      <section className={s.loginPanel}>
        <h1>Uitnodiging accepteren</h1>

        {error && <ErrorNotice>{error}</ErrorNotice>}

        {info && (
          <form onSubmit={accept} className={s.stack}>
            <p>
              <strong>{info.organisation}</strong>

              <br />

              {info.email}
            </p>

            {!account && (
              <>
                <Field
                  label="Naam"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />

                <Field
                  label="Nieuw wachtwoord"
                  type="password"
                  minLength={12}
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />

                <p className={s.muted}>
                  Minimaal 12 tekens. Heb je al een account? Log eerst in en open deze link opnieuw.
                </p>

                <Link to="/app">Naar inloggen</Link>
              </>
            )}

            <Button type="submit">Uitnodiging accepteren</Button>
          </form>
        )}
      </section>
    </main>
  );
}

export function Workspace() {
  const [account, setAccount] = useState<Account | null>(),
    [error, setError] = useState(''),
    [orgID, setOrgID] = useState('');

  const navigate = useNavigate(),
    location = useLocation();

  const loadAccount = useCallback(() => {
    setError('');

    void api<Account>('/me')
      .then((value) => {
        setAccount(value);

        setOrgID((current) =>
          value.organisations.some((o) => o.id === current)
            ? current
            : value.organisations[0]?.id || '',
        );
      })

      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setAccount(null);
        else setError(errorText(e));
      });
  }, []);

  useEffect(() => {
    loadAccount();

    const expired = () => {
      setScope('');

      setAccount(null);
    };

    window.addEventListener('satvey-auth-expired', expired);

    window.addEventListener('satvey-auth-changed', loadAccount);

    return () => {
      window.removeEventListener('satvey-auth-expired', expired);

      window.removeEventListener('satvey-auth-changed', loadAccount);
    };
  }, [loadAccount]);

  useEffect(() => {
    document.documentElement.lang = 'nl';

    document.title = 'Satvey · Inspecties';
  }, []);

  if (location.pathname === '/invite')
    return (
      <Invitation
        account={account || null}
        onDone={() => {
          loadAccount();

          navigate('/app');
        }}
      />
    );

  if (error)
    return (
      <main className={s.login}>
        <ErrorNotice>{error}</ErrorNotice>

        <Button onClick={loadAccount}>Opnieuw proberen</Button>
      </main>
    );

  if (account === undefined) return <Loading />;

  if (!account) return <Login onLogin={loadAccount} />;

  const org = account.organisations.find((o) => o.id === orgID);

  if (!org)
    return (
      <main className={s.login}>
        <section className={s.loginPanel}>
          <h1>Geen organisatie</h1>

          <p>Open de uitnodigingslink van je beheerder om een organisatie toe te voegen.</p>

          <Button
            onClick={async () => {
              await api('/auth/logout', json('POST', {}));

              setAccount(null);
            }}
          >
            Uitloggen
          </Button>
        </section>
      </main>
    );

  return (
    <OrganisationWorkspace
      key={`${account.user.id}:${org.id}`}
      account={account}
      org={org}
      onOrg={setOrgID}
      onLogout={() => {
        setAccount(null);

        navigate('/app');
      }}
    />
  );
}

function OrganisationWorkspace({
  account,

  org,

  onOrg,

  onLogout,
}: {
  account: Account;

  org: Organisation;

  onOrg: (id: string) => void;

  onLogout: () => void;
}) {
  const scope = `${account.user.id}:${org.id}`,
    base = `/orgs/${org.id}`,
    { items, error: storageError } = useOutbox(scope);

  const [online, setOnline] = useState(navigator.onLine),
    [error, setError] = useState(''),
    [logoutOpen, setLogoutOpen] = useState(false);

  const location = useLocation(),
    match = location.pathname.match(/^\/app\/inspections\/([^/]+)(?:\/(capture|review|report))?$/),
    settings = location.pathname === '/app/settings',
    norms = location.pathname === '/app/norms',
    formats = location.pathname === '/app/formats';

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);

    window.addEventListener('online', update);

    window.addEventListener('offline', update);

    return () => {
      window.removeEventListener('online', update);

      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (items.some((i) => i.state === 'uploading')) e.preventDefault();
    };

    window.addEventListener('beforeunload', guard);

    return () => window.removeEventListener('beforeunload', guard);
  }, [items]);

  async function logout() {
    try {
      setScope('');

      await api('/auth/logout', json('POST', {}));

      onLogout();
    } catch (e) {
      setScope(scope);

      setError(errorText(e));
    }
  }

  return (
    <div className={s.app}>
      <a className="skip-link" href="#workspace">
        Naar inhoud
      </a>

      <aside className={s.sidebar}>
        <Link to="/app" className={s.brand} aria-label="Satvey inspecties">
          <BrandMark size={29} />

          <strong>satvey.</strong>
        </Link>

        <div className={s.orgBlock}>
          {account.organisations.length > 1 ? (
            <Select label="Organisatie" value={org.id} onChange={onOrg}>
              {account.organisations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          ) : (
            <strong>{org.name}</strong>
          )}
        </div>

        <nav aria-label="Hoofdnavigatie">
          {can(org, 'inspections.read') && (
            <Link className={!settings && !norms && !formats ? s.activeNav : ''} to="/app">
              <ClipboardList size={19} />
              Inspecties
            </Link>
          )}

          {can(org, 'norms.read') && (
            <Link className={norms ? s.activeNav : ''} to="/app/norms">
              <BookOpen size={19} />
              Normen
            </Link>
          )}

          {can(org, 'formats.read') && (
            <Link className={formats ? s.activeNav : ''} to="/app/formats">
              <ClipboardList size={19} />
              Inspectieformats
            </Link>
          )}

          <Link className={settings ? s.activeNav : ''} to="/app/settings">
            <Settings size={19} />
            Instellingen
          </Link>
        </nav>

        <div className={s.user}>
          <span>
            {account.user.name}

            <small>{org.roleName}</small>
          </span>

          <Button
            variant="ghost"
            aria-label="Uitloggen"
            onClick={() => (items.length ? setLogoutOpen(true) : void logout())}
          >
            <LogOut size={18} />
          </Button>
        </div>
      </aside>

      <div className={s.body}>
        <header className={s.topbar}>
          <span>
            {settings
              ? 'Instellingen'
              : formats
                ? 'Inspectieformats'
                : norms
                  ? 'Normen'
                  : 'Inspecties'}
          </span>

          <div className={s.syncStatus} role="status">
            {!online && (
              <>
                <WifiOff size={15} />
                Offline ·{' '}
              </>
            )}

            {items.length ? (
              <button onClick={() => void sync(scope)}>
                <RefreshCw size={14} />
                {items.length} op apparaat
              </button>
            ) : (
              <>
                <CheckCheck size={16} />
                Opgeslagen
              </>
            )}
          </div>
        </header>

        <main id="workspace" className={s.main}>
          {(error || storageError) && <ErrorNotice>{error || storageError}</ErrorNotice>}

          {settings ? (
            <SettingsView base={base} org={org} scope={scope} />
          ) : formats ? (
            can(org, 'formats.read') ? (
              <FormatsModule base={base} scope={scope} org={org} />
            ) : (
              <ErrorNotice>Je rol kan geen inspectieformats bekijken.</ErrorNotice>
            )
          ) : norms ? (
            can(org, 'norms.read') ? (
              <NormsModule base={base} scope={scope} org={org} />
            ) : (
              <ErrorNotice>Je rol kan normen niet bekijken.</ErrorNotice>
            )
          ) : match && can(org, 'inspections.read') ? (
            <InspectionWorkspace
              key={match[1]}
              base={base}
              scope={scope}
              org={org}
              inspectionId={match[1]}
              stage={match[2] || 'capture'}
              pending={items}
            />
          ) : can(org, 'inspections.read') ? (
            <InspectionList base={base} scope={scope} canWrite={can(org, 'inspections.write')} />
          ) : can(org, 'norms.read') ? (
            <NormsModule base={base} scope={scope} org={org} />
          ) : (
            <SettingsView base={base} org={org} scope={scope} />
          )}

          {items.some((i) => i.state === 'failed' || i.state === 'conflict') && (
            <section className={s.queuePanel} aria-label="Synchronisatieproblemen">
              <h2>Nog niet opgeslagen op de server</h2>

              {items

                .filter((i) => i.state === 'failed' || i.state === 'conflict')

                .map((item) => (
                  <div key={item.id} className={s.stack}>
                    <ErrorNotice>{item.error}</ErrorNotice>

                    {item.kind === 'edit' && (
                      <>
                        <p>Jouw lokale wijziging:</p>

                        <pre>
                          {String(item.payload.title || '')}

                          {'\n'}

                          {String(
                            item.payload.description ||
                              item.payload.transcript ||
                              item.payload.note ||
                              item.payload.status ||
                              (Array.isArray(item.payload.shapes)
                                ? `${item.payload.shapes.length} fotomarkeringen ? open de foto om te vergelijken.`
                                : '') ||
                              '',
                          )}
                        </pre>

                        <p>
                          Open de nieuwste versie en vergelijk je tekst voordat je opnieuw opslaat.
                        </p>
                      </>
                    )}

                    {item.files && <LocalGallery files={item.files} />}

                    <div className={s.actions}>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          void saveAction({ ...item, state: 'pending' }).then(() => sync(scope));
                        }}
                        disabled={item.state === 'conflict'}
                      >
                        Opnieuw proberen
                      </Button>

                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (
                            window.confirm(
                              'Deze lokale wijziging verwijderen? Niet geüploade bestanden worden van dit apparaat verwijderd.',
                            )
                          )
                            void removeAction(item.id);
                        }}
                      >
                        Lokale wijziging verwijderen
                      </Button>
                    </div>
                  </div>
                ))}
            </section>
          )}
        </main>
      </div>

      <Dialog
        open={logoutOpen}
        onOpenChange={setLogoutOpen}
        title="Er staan nog wijzigingen op dit apparaat"
        description="Ze blijven bewaard voor dit account. Na opnieuw inloggen worden ze verder gesynchroniseerd."
      >
        <div className={s.actions}>
          <Button variant="secondary" onClick={() => setLogoutOpen(false)}>
            Terug
          </Button>

          <Button onClick={() => void logout()}>Uitloggen</Button>
        </div>
      </Dialog>
    </div>
  );
}

const propertyIconTones = [
  'propertyOlive',
  'propertyBlue',
  'propertyTerracotta',
  'propertyAmber',
  'propertyPlum',
  'propertyTeal',
] as const;
function propertyIconTone(propertyId: string) {
  let hash = 0;
  for (const char of propertyId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return s[propertyIconTones[hash % propertyIconTones.length]];
}
function InspectionList({
  base,

  scope,

  canWrite,
}: {
  base: string;

  scope: string;

  canWrite: boolean;
}) {
  const { data, error, cached } = useResource<Inspection[]>(scope, `${base}/inspections`);

  const [create, setCreate] = useState(false),
    [query, setQuery] = useState('');

  return (
    <>
      <div className={s.pageHeading}>
        <div>
          <h1>Inspecties</h1>

          <p className={s.muted}>
            {data?.filter((i) => i.status === 'draft').length || 0} openstaand
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
          onChange={(e) => setQuery(e.target.value)}
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
          {data

            .filter((i) => `${i.address} ${i.city}`.toLowerCase().includes(query.toLowerCase()))

            .map((i) => (
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

      {create && <NewInspection base={base} scope={scope} onClose={() => setCreate(false)} />}
    </>
  );
}

function DeleteInspection({
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

function NewInspection({
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

function InspectionWorkspace({
  base,

  scope,

  org,

  inspectionId,

  stage,

  pending,
}: {
  base: string;

  scope: string;

  org: Organisation;

  inspectionId: string;

  stage: string;

  pending: Action[];
}) {
  const path = `${base}/inspections/${inspectionId}`,
    { data, error, cached } = useResource<Dossier>(scope, path),
    [roomId, setRoomId] = useState(''),
    [cameraOpen, setCameraOpen] = useState(false);
  const navigate = useNavigate();

  const write = can(org, 'inspections.write') && data?.inspection.status !== 'final';

  useEffect(() => {
    if (data && !roomId) setRoomId(data.rooms[0]?.id || '');
  }, [data, roomId]);
  const reviewRoomIds = data?.rooms.map((r) => r.id).join(',') || '';
  useEffect(() => {
    if (stage !== 'review' || !reviewRoomIds) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const current = entries.find((entry) => entry.isIntersecting);
        if (current) setRoomId(current.target.id.replace('review-room-', ''));
      },
      { rootMargin: '-10% 0px -70% 0px' },
    );
    for (const id of reviewRoomIds.split(',')) {
      const element = document.getElementById(`review-room-${id}`);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [stage, reviewRoomIds]);

  if (!data)
    return (
      <>
        {error ? <ErrorNotice>{error}</ErrorNotice> : <Loading />}

        <Link to="/app">Alle inspecties</Link>
      </>
    );

  const local = pending.filter((p) => p.inspectionId === inspectionId),
    reviewed = data.format
      ? data.rooms.filter((r) => r.generation === r.approvedGeneration).length
      : data.batches.filter((b) => b.status !== 'pending').length;

  return (
    <>
      <Link to="/app" className={s.back}>
        <ArrowLeft size={16} />
        Alle inspecties
      </Link>

      <div className={s.pageHeading}>
        <div>
          <p className={s.eyebrow}>{kindLabel(data.inspection.kind)}</p>

          <h1>{data.inspection.address}</h1>

          {data.format && (
            <p className={s.muted}>
              Format: {data.format.name} · versie {data.format.number}
            </p>
          )}

          {data.norms && (
            <p className={s.muted}>
              Normenkader: {data.norms.name} · versie {data.norms.number}
            </p>
          )}

          <p className={s.muted}>
            {data.inspection.postcode} {data.inspection.city} ·{' '}
            {dateLabel(data.inspection.scheduledAt)}
          </p>
        </div>

        <div className={s.actions}>
          <Badge tone={data.inspection.status === 'final' ? 'success' : 'neutral'}>
            {data.inspection.status === 'final'
              ? 'Vastgelegd'
              : `${reviewed}/${data.format ? data.rooms.length : data.batches.length} ${data.format ? 'ruimtes' : 'opnamen'} beoordeeld`}
          </Badge>
          {can(org, 'inspections.write') && (
            <DeleteInspection
              base={base}
              scope={scope}
              inspection={data.inspection}
              onDeleted={() => navigate('/app', { replace: true })}
            />
          )}
        </div>
      </div>

      {error && (
        <ErrorNotice>
          {cached ? 'Offline: dit dossier is op je apparaat beschikbaar.' : error}
        </ErrorNotice>
      )}

      <InspectionProperty
        inspection={data.inspection}
        base={base}
        scope={scope}
        canWrite={!!write}
        canManage={can(org, 'settings.manage')}
      />

      <nav className={s.stages} aria-label="Inspectiestappen">
        {[
          ['capture', 'Opnemen', Camera],

          ['review', 'Beoordelen', CheckCheck],

          ['report', 'Rapport', ClipboardList],
        ].map(([key, label, Icon]) => {
          const I = Icon as typeof Camera;

          return (
            <Link
              key={String(key)}
              aria-current={stage === key ? 'step' : undefined}
              className={stage === key ? s.activeStage : ''}
              to={`/app/inspections/${inspectionId}/${key}`}
            >
              <I size={18} />

              {String(label)}
            </Link>
          );
        })}
      </nav>

      {cameraOpen && stage === 'capture' && write && (
        <CameraSession
          scope={scope}
          path={path}
          data={data}
          initialRoomId={roomId}
          onRoomChange={setRoomId}
          onClose={() => setCameraOpen(false)}
        />
      )}
      {stage === 'report' ? (
        <ReportView
          org={org}
          scope={scope}
          path={path}
          data={data}
          pending={local}
          canWrite={!!write}
        />
      ) : (
        <div className={s.inspectionGrid}>
          <aside className={s.rooms}>
            <h2>Ruimtes</h2>

            <nav aria-label="Ruimtes">
              {data.rooms.map((room) => (
                <button
                  key={room.id}
                  className={room.id === roomId ? s.selectedRoom : ''}
                  aria-current={room.id === roomId ? 'location' : undefined}
                  onClick={() => {
                    setRoomId(room.id);
                    if (stage === 'review')
                      document
                        .getElementById(`review-room-${room.id}`)
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  <House size={17} />

                  <span>{room.name}</span>

                  <small>
                    {data.format
                      ? room.approvedGeneration === room.generation
                        ? '\u2713'
                        : 'Open'
                      : data.batches.filter((b) => b.roomId === room.id).length}
                  </small>
                </button>
              ))}
            </nav>

            {write && <AddRoom path={path} data={data} />}
          </aside>

          <div className={s.roomContent}>
            {(stage === 'review' ? data.rooms : data.rooms.filter((r) => r.id === roomId)).map(
              (room) => (
                <section
                  key={room.id}
                  id={`review-room-${room.id}`}
                  className={s.reviewRoom}
                  aria-label={room.name}
                >
                  <div className={s.roomHeading}>
                    <h2>{room.name}</h2>
                    <span className={s.muted}>
                      {data.batches.filter((b) => b.roomId === room.id).length} opnamen
                    </span>
                  </div>
                  {stage === 'capture' && write && (
                    <Capture
                      key={room.id}
                      scope={scope}
                      path={path}
                      inspectionId={inspectionId}
                      roomId={room.id}
                      pending={local}
                      data={data}
                      onOpenCamera={() => setCameraOpen(true)}
                    />
                  )}
                  {data.batches
                    .filter((b) => b.roomId === room.id)
                    .map((batch) => (
                      <BatchCard
                        key={batch.id}
                        batch={batch}
                        data={data}
                        org={org}
                        scope={scope}
                        path={path}
                        canWrite={!!write}
                        review={stage === 'review'}
                        pending={local}
                      />
                    ))}
                  {!data.batches.some((b) => b.roomId === room.id) && (
                    <p className={s.emptySmall}>Nog geen opnamen in deze ruimte.</p>
                  )}
                  {data.format && stage === 'review' && (
                    <FormatRoomReview
                      data={data}
                      room={room}
                      path={path}
                      scope={scope}
                      org={org.id}
                      pending={local}
                      canWrite={!!write}
                    />
                  )}
                </section>
              ),
            )}
            {stage === 'capture' && (
              <Link className={s.nextLink} to={`/app/inspections/${inspectionId}/review`}>
                Opnamen beoordelen <ArrowRight size={17} />
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function AddRoom({ path, data }: { path: string; data: Dossier }) {
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

function LocalGallery({ files, remove }: { files: LocalMedia[]; remove?: (id: string) => void }) {
  return (
    <div className={s.gallery}>
      {files.map((file) => (
        <LocalPreview key={file.id} file={file} remove={remove} />
      ))}
    </div>
  );
}

function LocalPreview({ file, remove }: { file: LocalMedia; remove?: (id: string) => void }) {
  const [url, setURL] = useState('');

  useEffect(() => {
    const u = URL.createObjectURL(new Blob([file.bytes], { type: file.mime }));

    setURL(u);

    return () => URL.revokeObjectURL(u);
  }, [file.bytes, file.mime]);

  return (
    <div className={file.mime.startsWith('audio') ? s.audioPreview : s.photoPreview}>
      {file.mime.startsWith('image') ? (
        <a href={url} download={file.name}>
          <img src={url} alt={file.name} />
        </a>
      ) : (
        <>
          <audio controls src={url} aria-label={file.name} />

          <a href={url} download={file.name}>
            Audio downloaden
          </a>
        </>
      )}

      {remove && (
        <button
          type="button"
          aria-label={`${file.name} verwijderen`}
          onClick={() => remove(file.id)}
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}

function Capture({
  scope,

  path,

  inspectionId,

  roomId,

  pending,

  data,
  onOpenCamera,
}: {
  onOpenCamera: () => void;
  data: Dossier;

  scope: string;

  path: string;

  inspectionId: string;

  roomId: string;

  pending: Action[];
}) {
  const draftKey = `${scope}:capture:${inspectionId}:${roomId}`,
    [files, setFiles] = useState<LocalMedia[]>([]),
    [error, setError] = useState(''),
    [ready, setReady] = useState(false),
    [saving, setSaving] = useState(false),
    [recording, setRecording] = useState(false),
    [seconds, setSeconds] = useState(0),
    [notice, setNotice] = useState('');

  const input = useRef<HTMLInputElement>(null),
    recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    timer = useRef<number | undefined>(undefined),
    mounted = useRef(true),
    currentFiles = useRef(files),
    audioAbort = useRef(false);

  useEffect(() => {
    let alive = true;

    mounted.current = true;

    void draftGet(draftKey)
      .then((d) => {
        if (alive) {
          setFiles(d?.files || []);

          currentFiles.current = d?.files || [];

          setReady(true);
        }
      })

      .catch((e) => setError(errorText(e)));

    return () => {
      alive = false;

      mounted.current = false;

      audioAbort.current = true;

      if (recorder.current?.state === 'recording') recorder.current.stop();

      stream.current?.getTracks().forEach((t) => t.stop());

      window.clearInterval(timer.current);
    };
  }, [draftKey]);

  async function store(next: LocalMedia[]) {
    currentFiles.current = next;

    setFiles(next);

    setNotice('');

    try {
      await draftPut(draftKey, { roomId, files: next });
    } catch (e) {
      setError(`Opslaan op apparaat mislukt. Houd dit scherm open. ${errorText(e)}`);

      throw e;
    }
  }

  async function add(selected: File[]) {
    setError('');

    const additions: LocalMedia[] = [];

    try {
      for (const file of selected) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
          throw new Error(
            'Gebruik JPG, PNG of WebP. Kies op je telefoon zo nodig een compatibel cameraformaat.',
          );

        if (file.size > 20 * 1024 * 1024) throw new Error('Maximaal 20 MB per foto.');

        additions.push({
          id: uuid(),

          name: file.name,

          mime: file.type,

          bytes: await file.arrayBuffer(),

          duration: 0,
        });
      }

      if (currentFiles.current.length + additions.length > 30)
        throw new Error('Maximaal 30 bestanden per opname.');

      await store([...currentFiles.current, ...additions]);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function startRecording() {
    setError('');

    setNotice('');

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError('Audio opnemen vereist een ondersteunde browser op localhost of HTTPS.');

      return;
    }

    if (files.length >= 30) {
      setError('Maximaal 30 bestanden per opname.');

      return;
    }

    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });

      if (!mounted.current) {
        mic.getTracks().forEach((t) => t.stop());

        return;
      }

      stream.current = mic;

      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) =>
        MediaRecorder.isTypeSupported(t),
      );

      const rec = new MediaRecorder(mic, mime ? { mimeType: mime } : undefined);

      recorder.current = rec;

      const chunks: Blob[] = [];

      const started = Date.now();

      audioAbort.current = false;

      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };

      rec.onerror = () => {
        setError('Opnemen onderbroken. Controleer de opgeslagen audio en probeer opnieuw.');

        rec.stop();
      };

      rec.onstop = () => {
        mic.getTracks().forEach((t) => t.stop());

        clearInterval(timer.current);

        if (mounted.current) setRecording(false);

        const type = rec.mimeType.split(';')[0],
          blob = new Blob(chunks, { type });

        if (audioAbort.current || !mounted.current) return;

        if (!blob.size) {
          setError('Geen audio opgenomen. Probeer opnieuw.');

          return;
        }

        if (blob.size > 50 * 1024 * 1024) {
          setError('Audio groter dan 50 MB. Maak een kortere opname.');

          return;
        }

        void blob

          .arrayBuffer()

          .then((bytes) =>
            store([
              ...currentFiles.current,

              {
                id: uuid(),

                name: `Spraaknotitie-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`,

                mime: type,

                bytes,

                duration: Math.min(600, (Date.now() - started) / 1000),
              },
            ]),
          )

          .catch((e) => setError(errorText(e)));
      };

      rec.start(1000);

      setSeconds(0);

      setRecording(true);

      timer.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1000);

        setSeconds(elapsed);

        if (elapsed >= 600 && rec.state === 'recording') rec.stop();
      }, 1000);
    } catch (e) {
      stream.current?.getTracks().forEach((t) => t.stop());

      setError(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Microfoontoegang geweigerd. Geef toestemming in je browser en probeer opnieuw.'
          : errorText(e),
      );
    }
  }

  async function save() {
    setSaving(true);

    setError('');

    try {
      const id = uuid();

      await saveAction({
        id,

        scope,

        inspectionId,

        kind: 'capture',

        path: `${path}/batches`,

        payload: { id, roomId, mediaIds: files.map((f) => f.id) },

        files,

        uploaded: [],

        createdAt: Date.now(),

        state: 'pending',
      });

      await draftRemove(draftKey);

      setFiles([]);

      currentFiles.current = [];

      setNotice('Opname op apparaat bewaard.');

      void sync(scope);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={s.capture} aria-label="Nieuwe opname">
      <div className={s.captureActions}>
        <Button
          size="lg"
          icon={<Camera size={21} />}
          onClick={onOpenCamera}
          disabled={!ready || saving || recording}
        >
          Foto maken
        </Button>

        <Button variant="ghost" onClick={() => input.current?.click()} disabled={!ready || saving}>
          Foto’s toevoegen
        </Button>
        {recording ? (
          <Button
            size="lg"
            variant="destructive"
            icon={<Square size={18} />}
            onClick={() => recorder.current?.stop()}
          >
            Stop {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
          </Button>
        ) : (
          <Button
            size="lg"
            variant="secondary"
            icon={<Mic size={21} />}
            onClick={() => void startRecording()}
            disabled={!ready || saving}
          >
            Audio opnemen
          </Button>
        )}
      </div>

      {data.format && <TalkingGuide data={data} roomId={roomId} recording={recording} />}

      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        multiple
        hidden
        aria-label="Foto's toevoegen"
        onChange={(e) => {
          void add(Array.from(e.target.files || []));

          e.target.value = '';
        }}
      />

      {recording && (
        <p className={s.recording} role="status">
          <span />
          Microfoon actief · blijf op dit scherm
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              audioAbort.current = true;

              recorder.current?.stop();
            }}
          >
            Opname verwerpen
          </Button>
        </p>
      )}

      {files.length > 0 && (
        <>
          <LocalGallery
            files={files}
            remove={(id) => {
              void store(files.filter((f) => f.id !== id)).catch(() => {});
            }}
          />

          <div className={s.captureFooter}>
            <Badge tone="warning">Concept op apparaat</Badge>

            <span>
              {files.filter((f) => f.mime.startsWith('image')).length} foto's ·{' '}
              {files.filter((f) => f.mime.startsWith('audio')).length} audio
            </span>

            <Button
              loading={saving}
              disabled={recording}
              icon={<Upload size={17} />}
              onClick={() => void save()}
            >
              Opname bewaren
            </Button>
          </div>
        </>
      )}

      {notice && (
        <p role="status" className={s.muted}>
          {notice}
        </p>
      )}

      {error && <ErrorNotice>{error}</ErrorNotice>}

      {pending

        .filter((p) => p.kind === 'capture' && p.payload.roomId === roomId)

        .map((p) => (
          <div className={s.localBatch} key={p.id}>
            <Badge tone={p.state === 'failed' || p.state === 'conflict' ? 'danger' : 'warning'}>
              {p.state === 'uploading'
                ? 'Uploaden'
                : p.state === 'pending'
                  ? 'Op apparaat'
                  : 'Mislukt'}{' '}
              · {p.uploaded?.length || 0}/{p.files?.length || 0}
            </Badge>

            <LocalGallery files={p.files || []} />
          </div>
        ))}
    </section>
  );
}

function Gallery({
  media,
  org,
  editing,
}: {
  media: Media[];
  org: string;
  editing?: { scope: string; path: string; inspectionId: string };
}) {
  return (
    <div className={s.gallery}>
      {media.map((m) =>
        m.kind === 'photo' ? (
          <PhotoTile key={m.id} media={m} org={org} editing={editing} />
        ) : (
          <div className={s.audioPreview} key={m.id}>
            <span>
              <Mic size={15} />
              Spraaknotitie · intern
            </span>

            <audio controls preload="metadata" src={mediaURL(org, m.id)} aria-label={m.name} />
          </div>
        ),
      )}
    </div>
  );
}

function BatchCard({
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

function suggestedObservationTitle(description: string) {
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
function ObservationEditor({
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
          <details>
            <summary>Label (optioneel)</summary>
            <Field
              label="Label (optioneel)"
              value={draft.label}
              maxLength={100}
              disabled={queued}
              onChange={(e) => patch({ label: e.target.value })}
            />
          </details>
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

function ReportView({
  org,

  scope,

  path,

  data,

  pending,

  canWrite,
}: {
  org: Organisation;

  scope: string;

  path: string;

  data: Dossier;

  pending: Action[];

  canWrite: boolean;
}) {
  const [report, setReport] = useState<Report>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [pdfBusy, setPDFBusy] = useState(false),
    [finaliseOpen, setFinaliseOpen] = useState(false),
    [signatures, setSignatures] = useState<SignatureInput[]>([]);

  const [draftCount, setDraftCount] = useState<number>();

  const observationKey = data.observations

    .map((o) => o.id)

    .sort()

    .join(',');

  useEffect(() => {
    let alive = true;

    const check = () => {
      void pendingDraftCount(scope, data.inspection.id, observationKey.split(',').filter(Boolean))
        .then((count) => {
          if (alive) setDraftCount(count);
        })

        .catch((e) => {
          if (alive) setError(errorText(e));
        });
    };

    check();

    window.addEventListener('satvey-drafts', check);

    return () => {
      alive = false;

      window.removeEventListener('satvey-drafts', check);
    };
  }, [scope, data.inspection.id, observationKey]);

  useEffect(() => {
    if (data.inspection.status === 'final')
      void api<Report>(`${path}/report`)
        .then(setReport)

        .catch((e) => setError(errorText(e)));
  }, [data.inspection.status, path]);

  const approved =
    report?.observations ||
    data.observations.filter(
      (o) =>
        o.status === 'approved' &&
        data.batches.find((b) => b.id === o.batchId)?.status === 'reviewed',
    );

  const unresolved = data.format
      ? data.rooms.filter((r) => r.approvedGeneration !== r.generation).length
      : data.batches.filter((b) => b.status === 'pending').length,
    ready = data.format
      ? !unresolved && !pending.length && draftCount === 0
      : !unresolved &&
        !!data.batches.length &&
        !pending.length &&
        !(data.assessments || []).some(
          (a) =>
            data.batches.find((b) => b.id === a.batchId)?.status !== 'excluded' &&
            (!a.reviewedOutcome || a.stale),
        ) &&
        draftCount === 0 &&
        !data.jobs.some(
          (j) =>
            j.status !== 'done' &&
            data.batches.find((b) => b.id === j.batchId)?.status !== 'excluded',
        );

  async function finalise() {
    setBusy(true);

    setError('');

    try {
      await sync(scope);

      if (
        await pendingDraftCount(
          scope,

          data.inspection.id,

          observationKey.split(',').filter(Boolean),
        )
      )
        throw new Error('Bewaar of verwijder eerst je lokale concepten.');

      if ((await actions(scope)).some((a) => a.inspectionId === data.inspection.id))
        throw new Error('Synchroniseer eerst de wijzigingen op dit apparaat.');

      const value = await api<Report>(
        `${path}/report`,
        json('POST', {
          signatures: signatures.filter(
            (signature) => signature.name.trim() || signature.strokes.length,
          ),
        }),
      );

      setReport(value);
      setFinaliseOpen(false);
      setSignatures([]);

      announceRefresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function downloadPDF() {
    setError('');

    setPDFBusy(true);

    try {
      if (data.inspection.status !== 'final') {
        if (
          await pendingDraftCount(
            scope,

            data.inspection.id,

            observationKey.split(',').filter(Boolean),
          )
        )
          throw new Error('Bewaar of verwijder eerst je lokale concepten.');

        if ((await actions(scope)).some((a) => a.inspectionId === data.inspection.id))
          throw new Error('Synchroniseer eerst de wijzigingen op dit apparaat.');
      }

      const { blob, filename } = await reportPDF(path);

      const url = URL.createObjectURL(blob),
        link = document.createElement('a');

      link.href = url;

      link.download = filename;

      document.body.appendChild(link);

      link.click();

      link.remove();

      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPDFBusy(false);
    }
  }

  return (
    <section className={s.stack}>
      <div className={s.reportToolbar}>
        <div>
          <h2>{report ? 'Vastgelegd rapport' : 'Conceptrapport'}</h2>

          <p className={s.muted}>
            {approved.length} goedgekeurde bevindingen
            {unresolved > 0 && ` · ${unresolved} opnamen te beoordelen`}
          </p>
        </div>

        <div className={s.actions}>
          <Button
            variant="secondary"
            icon={<Download size={17} />}
            loading={pdfBusy}
            disabled={
              busy ||
              (data.inspection.status !== 'final' && (draftCount !== 0 || pending.length > 0))
            }
            onClick={() => void downloadPDF()}
          >
            {pdfBusy
              ? 'PDF maken…'
              : data.inspection.status === 'final'
                ? 'PDF downloaden'
                : 'Concept-PDF downloaden'}
          </Button>

          {canWrite && (
            <Button
              disabled={!ready || data.inspection.propertySnapshot?.linkState !== 'linked'}
              loading={busy}
              onClick={() => {
                setError('');
                setSignatures([]);
                setFinaliseOpen(true);
              }}
            >
              Rapport vastleggen
            </Button>
          )}
        </div>
      </div>

      {!!draftCount && !report && (
        <p className={s.warning}>
          Er staan nog {draftCount} concepten op dit apparaat. Bewaar of verwijder ze bij Opnemen of
          Beoordelen.
        </p>
      )}

      {pending.length > 0 && (
        <p className={s.warning}>Er staan nog {pending.length} wijzigingen op dit apparaat.</p>
      )}

      {error && !finaliseOpen && <ErrorNotice>{error}</ErrorNotice>}

      <Dialog
        open={finaliseOpen}
        onOpenChange={(open) => {
          if (!busy) setFinaliseOpen(open);
        }}
        title="Inspectie afronden"
        description={data.inspection.address}
        closeLabel="Sluiten"
        fullOnMobile
      >
        <div className={s.stack}>
          <p>
            Na het vastleggen kunnen het rapport, de opnamen en handtekeningen niet meer worden gewijzigd.
          </p>
          <SignaturesEditor value={signatures} onChange={setSignatures} disabled={busy} />
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <div className={s.actions}>
            <Button variant="secondary" disabled={busy} onClick={() => setFinaliseOpen(false)}>
              Annuleren
            </Button>
            <Button loading={busy} onClick={() => void finalise()}>
              Rapport definitief vastleggen
            </Button>
          </div>
        </div>
      </Dialog>

      <article className={s.report} aria-label="Inspectierapport">
        <header>
          <BrandMark size={28} />

          <strong>satvey.</strong>

          <span>{report ? 'Vastgelegd' : 'Concept'}</span>
        </header>

        <p className={s.eyebrow}>
          {org.name} · {kindLabel(data.inspection.kind)}
        </p>

        <h2>{data.inspection.address}</h2>

        <p>
          {data.inspection.postcode} {data.inspection.city}
        </p>

        {report && <p className={s.muted}>Vastgelegd op {dateLabel(report.createdAt)}</p>}
        {(report?.inspection.propertySnapshot || data.inspection.propertySnapshot) && (
          <section>
            <h3>Vastgoedobject</h3>
            <PropertyFacts
              property={(report?.inspection.propertySnapshot || data.inspection.propertySnapshot)!}
            />
          </section>
        )}

        <FormatReportResults
          data={report || data}
          org={org.id}
          editing={canWrite ? { scope, path, inspectionId: data.inspection.id } : undefined}
        />

        {(report?.norms || data.norms) && (
          <section>
            <h3>
              {(report?.norms || data.norms)?.name} · versie {(report?.norms || data.norms)?.number}
            </h3>

            {(
              report?.assessments ||
              (data.assessments || [])

                .filter(
                  (a) =>
                    a.reviewedOutcome &&
                    !a.stale &&
                    data.batches.find((b) => b.id === a.batchId)?.status === 'reviewed',
                )

                .map((a) => ({
                  ruleId: a.ruleId,

                  batchId: a.batchId,

                  outcome: a.reviewedOutcome!,

                  reason: a.reviewNote || a.reason,

                  photoIds: a.photoIds,
                }))
            ).map((a, index) => (
              <section key={index}>
                <strong>
                  {(report?.norms || data.norms)?.rules.find((r) => r.id === a.ruleId)?.title}
                </strong>{' '}
                · {outcomeLabels[a.outcome]}
                <p>{a.reason}</p>
                {!!a.photoIds?.length && (
                  <Gallery
                    media={(report?.media || data.media).filter(
                      (m) => m.kind === 'photo' && a.photoIds?.includes(m.id),
                    )}
                    org={org.id}
                    editing={
                      canWrite ? { scope, path, inspectionId: data.inspection.id } : undefined
                    }
                  />
                )}
              </section>
            ))}
          </section>
        )}

        {!approved.length && <p className={s.emptySmall}>Geen goedgekeurde bevindingen.</p>}

        {approved.map((o) => (
          <section key={o.id}>
            <p className={s.eyebrow}>
              {
                (report?.rooms || data.rooms).find(
                  (r) => r.id === data.batches.find((b) => b.id === o.batchId)?.roomId,
                )?.name
              }
            </p>

            <h3>{o.title}</h3>

            {o.label && <Badge>{o.label}</Badge>}

            <p className={s.description}>{o.description}</p>

            <Gallery
              media={(report?.media || data.media).filter(
                (m) =>
                  m.batchId === o.batchId &&
                  m.kind === 'photo' &&
                  (!o.photoIds?.length || o.photoIds.includes(m.id)),
              )}
              org={org.id}
              editing={canWrite ? { scope, path, inspectionId: data.inspection.id } : undefined}
            />
          </section>
        ))}
        <ReportSignatures signatures={report?.signatures || []} />
      </article>
    </section>
  );
}
