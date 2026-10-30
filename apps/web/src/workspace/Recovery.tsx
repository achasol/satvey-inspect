import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, Field } from '../components/ui';
import { api, json } from './api';
import s from './workspace.module.css';

export function Recovery() {
  const reset = window.location.pathname === '/reset-password';
  // Fragment tokens never enter HTTP access logs or referrer headers.
  const [token] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get('token') || '',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (reset && password !== confirmation) {
      setError('De wachtwoorden komen niet overeen.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api(
        reset ? '/auth/password/reset' : '/auth/password/forgot',
        json('POST', reset ? { token, password } : { email }),
      );
      setDone(true);
      setPassword('');
      setConfirmation('');
      if (reset) window.history.replaceState(null, '', '/reset-password');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Probeer het opnieuw.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className={s.login}>
      <section className={s.loginPanel}>
        <h1>{reset ? 'Nieuw wachtwoord' : 'Wachtwoord vergeten'}</h1>
        {done ? (
          <p role="status">
            {reset
              ? 'Je wachtwoord is gewijzigd. Log opnieuw in.'
              : 'Als dit e-mailadres een wachtwoordaccount heeft, ontvang je een herstellink.'}
          </p>
        ) : (
          <form onSubmit={submit} className={s.stack}>
            {reset ? (
              <>
                <Field
                  label="Nieuw wachtwoord"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={256}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Field
                  label="Wachtwoord herhalen"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={256}
                  required
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </>
            ) : (
              <Field
                label="E-mailadres"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
            {error && (
              <p role="alert" className={s.error}>
                {error}
              </p>
            )}
            <Button type="submit" loading={busy} disabled={reset && !token}>
              {reset ? 'Wachtwoord wijzigen' : 'Herstellink versturen'}
            </Button>
          </form>
        )}
        <Link to="/app">Terug naar inloggen</Link>
      </section>
    </main>
  );
}
