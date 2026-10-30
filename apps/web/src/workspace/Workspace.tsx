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
        setAccountIdentity(value.user.id);
        setAccount(value);

        setOrgID((current) =>
          value.organisations.some((o) => o.id === current)
            ? current
            : value.organisations[0]?.id || '',
        );
      })

      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          setAccountIdentity('');
          setAccount(null);
        } else setError(errorText(e));
      });
  }, []);

  useEffect(() => {
    loadAccount();

    const expired = () => {
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
