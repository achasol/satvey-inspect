import { networkOnline } from './connectivity';
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui';
import { api, ApiError, json, setAccountIdentity } from './api';
import type { Account } from './api';
import { setScope } from './outbox';
import s from './workspace.module.css';
import { errorText, ErrorNotice, Loading } from './shared';
import { Login, Invitation } from './auth';
import { Recovery } from './Recovery';
import { OrganisationWorkspace } from './shell';
import { rememberAccount, offlineAccount } from './offline';
import { nativeDevice } from './nativeStorage';
import { rememberSession } from './platform';
import { MobileAuthorize } from './MobileLogin';

export function Workspace() {
  const [account, setAccount] = useState<Account | null>(),
    [error, setError] = useState(''),
    [orgID, setOrgID] = useState('');

  const navigate = useNavigate(),
    location = useLocation();
  const mobileRequest =
    new URLSearchParams(location.search).get('mobileRequest') ||
    (!nativeDevice ? sessionStorage.getItem('satvey-mobile-request') : '');
  useEffect(() => {
    if (!nativeDevice && mobileRequest && /^[0-9a-f]{64}$/.test(mobileRequest))
      sessionStorage.setItem('satvey-mobile-request', mobileRequest);
  }, [mobileRequest]);

  const loadAccount = useCallback(() => {
    setError('');

    void api<Account>('/me')
      .then(async (value) => {
        await rememberAccount(value);
        setAccountIdentity(value.user.id);
        setAccount(value);

        setOrgID((current) =>
          value.organisations.some((o) => o.id === current)
            ? current
            : value.organisations[0]?.id || '',
        );
      })

      .catch(async (e) => {
        if (!(e instanceof ApiError) && nativeDevice) {
          try {
            const saved = await offlineAccount();
            if (saved) {
              setAccountIdentity(saved.user.id);
              setAccount(saved);
              setOrgID(saved.organisations[0].id);
              return;
            }
          } catch (recoveryError) {
            setError(errorText(recoveryError));
            return;
          }
        }
        if (e instanceof ApiError && e.status === 401) {
          if (nativeDevice) await rememberSession(undefined);
          setAccountIdentity('');
          setAccount(null);
        } else setError(errorText(e));
      });
  }, []);

  useEffect(() => {
    loadAccount();

    const expired = () => {
      if (nativeDevice) void rememberSession(undefined).catch((e) => setError(errorText(e)));
      setScope('');
      setAccountIdentity('');

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
    if (!nativeDevice) return;
    let checking = false;
    const check = async () => {
      if (checking || !account) return;
      checking = true;
      try {
        let reachable = false;
        if (networkOnline()) {
          try {
            const controller = new AbortController();
            const timeout = window.setTimeout(() => controller.abort(), 10000);
            let current: Account;
            try {
              current = await api<Account>('/me', { signal: controller.signal });
            } finally {
              clearTimeout(timeout);
            }
            if (
              current.user.id !== account.user.id ||
              !current.organisations.some((o) => o.id === orgID)
            )
              throw new ApiError(
                403,
                'Je toegang tot deze organisatie is gewijzigd. Meld je opnieuw aan.',
              );
            await rememberAccount(current);
            reachable = true;
          } catch (e) {
            if (e instanceof ApiError) throw e;
          }
        }
        if (!reachable) {
          const available = await offlineAccount();
          if (!available?.organisations.some((o) => o.id === orgID))
            throw new Error(
              'Offline toegang voor deze organisatie is verlopen. Maak verbinding; je lokale werk blijft bewaard.',
            );
        }
      } catch (e) {
        setScope('');
        setAccountIdentity('');
        setAccount(null);
        setError(errorText(e));
      } finally {
        checking = false;
      }
    };
    const failure = (event: Event) => setError((event as CustomEvent<string>).detail);
    const timer = window.setInterval(() => void check(), 30000);
    window.addEventListener('satvey-access-check', check);
    window.addEventListener('offline', check);
    window.addEventListener('satvey-platform-error', failure);
    return () => {
      clearInterval(timer);
      window.removeEventListener('satvey-access-check', check);
      window.removeEventListener('offline', check);
      window.removeEventListener('satvey-platform-error', failure);
    };
  }, [account, orgID]);

  useEffect(() => {
    document.documentElement.lang = 'nl';

    document.title = 'Satvey · Inspecties';
  }, []);

  if (['/forgot-password', '/reset-password'].includes(location.pathname)) return <Recovery />;

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

  if (!nativeDevice && mobileRequest && /^[0-9a-f]{64}$/.test(mobileRequest))
    return <MobileAuthorize account={account} requestId={mobileRequest} />;

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

              setAccountIdentity('');
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
        setAccountIdentity('');
        setAccount(null);

        navigate('/app');
      }}
    />
  );
}
