import { networkOnline } from './connectivity';
import { lazy, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  BookOpen,
  CheckCheck,
  ClipboardList,
  LogOut,
  RefreshCw,
  Settings,
  WifiOff,
} from 'lucide-react';
import { Avatar, BrandMark, Button, Dialog } from '../components/ui';
import { api, can, json } from './api';
import type { Account, Organisation } from './api';
import { removeAction, saveAction, setScope, sync, useOutbox, scopeDraftCount } from './outbox';
const NormsModule = lazy(async () => ({ default: (await import('./Norms')).NormsModule }));
const FormatsModule = lazy(async () => ({ default: (await import('./Formats')).FormatsModule }));
const SettingsView = lazy(async () => ({ default: (await import('./Settings')).SettingsView }));
import s from './workspace.module.css';
import { errorText, ErrorNotice, Select } from './shared';
import { InspectionList } from './inspections';
import { InspectionWorkspace } from './dossier';
import { LocalGallery } from './capture';
import { PropertyHistory } from './VisitWorkflow';
import { organisationTheme } from './theme';
import { protectedURL } from './platform';
import { Analytics } from './Analytics';
import { Sidebar } from './Sidebar';
import { OfflineVisits } from './OfflineVisits';
import { nativeDevice } from './nativeStorage';
import { rememberSession } from './platform';

export function OrganisationWorkspace({
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
  const firstName = account.user.name.trim().split(/\s+/)[0] || 'Gebruiker';

  const [online, setOnline] = useState(networkOnline()),
    [error, setError] = useState(''),
    [durabilityError, setDurabilityError] = useState(''),
    [drafts, setDrafts] = useState(0),
    [logoutOpen, setLogoutOpen] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const theme = organisationTheme(org.tint) as Record<string, string>;
    const previous = new Map(
      Object.keys(theme).map((key) => [key, root.style.getPropertyValue(key)]),
    );
    for (const [key, value] of Object.entries(theme)) root.style.setProperty(key, value);
    return () => {
      for (const [key, value] of previous) {
        if (value) root.style.setProperty(key, value);
        else root.style.removeProperty(key);
      }
    };
  }, [org.id, org.tint]);
  const location = useLocation(),
    match = location.pathname.match(
      /^\/app\/inspections\/([^/]+)(?:\/(capture|review|report|handover|dossier))?$/,
    ),
    analytics = location.pathname === '/app/analytics',
    settings = location.pathname === '/app/settings',
    norms = location.pathname === '/app/norms',
    formats = location.pathname === '/app/formats';

  useEffect(() => {
    const update = () => setOnline(networkOnline());

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

  useEffect(() => {
    const update = () => {
      void scopeDraftCount(scope)
        .then(setDrafts)
        .catch((e) => setError(errorText(e)));
    };
    update();
    window.addEventListener('satvey-outbox', update);
    window.addEventListener('satvey-drafts', update);
    return () => {
      window.removeEventListener('satvey-outbox', update);
      window.removeEventListener('satvey-drafts', update);
    };
  }, [scope]);

  useEffect(() => {
    const health = (event: Event) => setDurabilityError((event as CustomEvent<string>).detail);
    window.addEventListener('satvey-storage-health', health);
    return () => window.removeEventListener('satvey-storage-health', health);
  }, []);
  async function logout() {
    try {
      setScope('');

      if (nativeDevice) {
        if (networkOnline()) {
          try {
            await api('/auth/logout', json('POST', {}));
          } catch {
            /* Local sign-out must also work when the API is unreachable. */
          }
        }
        await rememberSession(undefined);
      } else await api('/auth/logout', json('POST', {}));

      onLogout();
    } catch (e) {
      setScope(scope);

      setError(errorText(e));
    }
  }

  return (
    <div className={s.app} style={organisationTheme(org.tint)}>
      <a className="skip-link" href="#workspace">
        Naar inhoud
      </a>

      <Sidebar>
        <Link to="/app" className={s.brand} aria-label="Satvey inspecties">
          <BrandMark size={29} />

          <strong>satvey.</strong>
        </Link>

        <div className={s.orgBlock}>
          {org.logoAssetId && (
            <img
              src={protectedURL(`/api/v1/orgs/${org.id}/norm-assets/${org.logoAssetId}`)}
              alt={org.name}
              style={{ maxWidth: 120, maxHeight: 48, objectFit: 'contain' }}
            />
          )}
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
          {nativeDevice && <Link to="/app/offline">Op dit apparaat</Link>}
          {can(org, 'inspections.read') && (
            <Link
              className={!settings && !norms && !formats && !analytics ? s.activeNav : ''}
              to="/app"
            >
              <ClipboardList size={19} />
              Inspecties
            </Link>
          )}

          {can(org, 'norms.read') && (
            <Link className={norms ? s.activeNav : ''} to="/app/norms">
              <BookOpen size={19} />
              Kwaliteitskaders
            </Link>
          )}

          {can(org, 'formats.read') && (
            <Link className={formats ? s.activeNav : ''} to="/app/formats">
              <ClipboardList size={19} />
              Inspectiesjablonen
            </Link>
          )}

          {can(org, 'settings.manage') && (
            <Link className={analytics ? s.activeNav : ''} to="/app/analytics">
              <ClipboardList size={19} />
              Analytics
            </Link>
          )}
          <Link className={settings ? s.activeNav : ''} to="/app/settings">
            <Settings size={19} />
            Instellingen
          </Link>
        </nav>

        <div className={s.user}>
          <div className={s.userIdentity}>
            <Avatar
              initials={Array.from(firstName)[0].toLocaleUpperCase('nl-NL')}
              label={firstName}
            />
            <span className={s.userName}>{firstName}</span>
          </div>

          <Button
            variant="ghost"
            aria-label="Uitloggen"
            onClick={() => (items.length || drafts ? setLogoutOpen(true) : void logout())}
          >
            <LogOut size={18} />
          </Button>
        </div>
      </Sidebar>

      <div className={s.body}>
        <header className={s.topbar}>
          <span>
            {settings
              ? 'Instellingen'
              : formats
                ? 'Inspectiesjablonen'
                : norms
                  ? 'Kwaliteitskaders'
                  : 'Inspecties'}
          </span>

          <div className={s.syncStatus} role="status">
            {!online && (
              <>
                <WifiOff size={15} />
                Offline ·{' '}
              </>
            )}

            {durabilityError ? (
              <strong>Opslagfout op apparaat</strong>
            ) : items.length || drafts ? (
              <button onClick={() => void sync(scope)}>
                <RefreshCw size={14} />
                {items.length} op apparaat{drafts ? ` ? ${drafts} lokale concepten` : ''}
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
          {(error || storageError || durabilityError) && (
            <ErrorNotice>{durabilityError || error || storageError}</ErrorNotice>
          )}

          {analytics ? (
            can(org, 'settings.manage') ? (
              <Analytics base={base} scope={scope} />
            ) : (
              <ErrorNotice>Analytics is beschikbaar voor beheerders.</ErrorNotice>
            )
          ) : settings ? (
            <SettingsView base={base} org={org} scope={scope} />
          ) : formats ? (
            can(org, 'formats.read') ? (
              <FormatsModule base={base} scope={scope} org={org} />
            ) : (
              <ErrorNotice>Je rol kan geen inspectiesjablonen bekijken.</ErrorNotice>
            )
          ) : norms ? (
            can(org, 'norms.read') ? (
              <NormsModule base={base} scope={scope} org={org} />
            ) : (
              <ErrorNotice>Je rol kan kwaliteitskaders niet bekijken.</ErrorNotice>
            )
          ) : location.pathname.match(/^\/app\/properties\/([^/]+)$/) &&
            can(org, 'inspections.read') ? (
            <PropertyHistory
              base={base}
              scope={scope}
              propertyID={location.pathname.split('/').pop()!}
            />
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
          ) : (location.pathname === '/app/offline' || (!online && nativeDevice)) &&
            can(org, 'inspections.read') ? (
            <OfflineVisits scope={scope} />
          ) : can(org, 'inspections.read') ? (
            <InspectionList
              base={base}
              scope={scope}
              canWrite={can(org, 'inspections.write')}
              org={org}
            />
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
