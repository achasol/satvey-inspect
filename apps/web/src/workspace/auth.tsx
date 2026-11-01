import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { BrandMark, Button, Field } from '../components/ui';
import { api, json } from './api';
import type { Account } from './api';
import s from './workspace.module.css';
import { errorText, ErrorNotice } from './shared';
import { nativeDevice } from './nativeStorage';
import { NativeLogin } from './MobileLogin';

export function Login({ onLogin }: { onLogin: () => void }) {
  return nativeDevice ? <NativeLogin /> : <BrowserLogin onLogin={onLogin} />;
}

function BrowserLogin({ onLogin }: { onLogin: () => void }) {
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
        <Link to="/forgot-password">Wachtwoord vergeten?</Link>
      </section>
    </main>
  );
}

export function Invitation({ account, onDone }: { account: Account | null; onDone: () => void }) {
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
