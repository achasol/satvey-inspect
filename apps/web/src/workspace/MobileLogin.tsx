import { useState } from 'react';
import { BrandMark, Button } from '../components/ui';
import type { Account } from './types';
import { api, json } from './api';
import { startMobileLogin } from './platform';
import { errorText, ErrorNotice } from './shared';
import s from './workspace.module.css';
export function NativeLogin() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <main className={s.login}>
      <section className={s.loginPanel}>
        <BrandMark />
        <h1>Satvey Inspect</h1>
        <p>
          Meld je aan met je organisatieaccount. Daarna kun je bezoeken voorbereiden voor offline
          gebruik.
        </p>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await startMobileLogin();
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Aanmelden
        </Button>
      </section>
    </main>
  );
}
export function MobileAuthorize({ account, requestId }: { account: Account; requestId: string }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <main className={s.login}>
      <section className={s.loginPanel}>
        <h1>Mobiele app koppelen</h1>
        <p>
          Je koppelt de Satvey Inspect-app aan {account.user.name} ({account.user.email}). Ga alleen
          verder als je de aanmelding zelf in de app hebt gestart.
        </p>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const request = requestId;
              const result = await api<{ url: string }>(
                '/auth/mobile/authorize',
                json('POST', { request }),
              );
              sessionStorage.removeItem('satvey-mobile-request');
              location.assign(result.url);
            } catch (e) {
              setError(errorText(e));
              setBusy(false);
            }
          }}
        >
          Deze appaanmelding bevestigen
        </Button>
        <a href="/app" onClick={() => sessionStorage.removeItem('satvey-mobile-request')}>
          Annuleren
        </a>
      </section>
    </main>
  );
}
