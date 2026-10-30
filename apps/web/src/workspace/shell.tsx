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
import { BrandMark, Button, Dialog } from '../components/ui';
import { api, can, json } from './api';
import type { Account, Organisation } from './api';
import { removeAction, saveAction, setScope, sync, useOutbox } from './outbox';
const NormsModule = lazy(async () => ({ default: (await import('./Norms')).NormsModule }));
const FormatsModule = lazy(async () => ({ default: (await import('./Formats')).FormatsModule }));
const SettingsView = lazy(async () => ({ default: (await import('./Settings')).SettingsView }));
import s from './workspace.module.css';
import { errorText, ErrorNotice, Select } from './shared';
import { InspectionList } from './inspections';
import { InspectionWorkspace } from './dossier';
import { LocalGallery } from './capture';

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
