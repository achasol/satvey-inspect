import { useState } from 'react';
import { Button, Field } from '../components/ui';
import { api, json } from './api';
import { useResource } from './useResource';
import { rememberSession } from './platform';
import { deviceHasPendingWork, clearDeviceStorage } from './outbox';
import { errorText, ErrorNotice } from './shared';
import s from './workspace.module.css';
export function PrivacyControls({ scope }: { scope: string }) {
  const { data } = useResource<{ user: { email: string } }>(scope, '/me');
  const [confirmation, setConfirmation] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <details className={s.panel}>
      <summary>Account verwijderen</summary>
      <div className={s.stack}>
        <p>
          Je aanmeldgegevens en lidmaatschappen worden verwijderd. Corporatiedossiers en historische
          rapporten volgen het afgesproken bewaarbeleid. Draag organisatiebeheer eerst over als je
          de laatste beheerder bent. Meld je voor deze handeling opnieuw aan.
        </p>
        <p>
          Controleer eerst dat al het werk is gesynchroniseerd. De lokale gegevens worden na
          accountverwijdering van dit apparaat verwijderd.
        </p>
        <Field
          label="Bevestig met je e-mailadres"
          type="email"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
        />
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <Button
          variant="destructive"
          disabled={confirmation !== data?.user.email}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              if (await deviceHasPendingWork())
                throw new Error(
                  'Er is nog niet-gesynchroniseerd werk op dit apparaat. Synchroniseer of herstel dit eerst.',
                );
              await api('/account/delete', json('POST', { confirmation }));
              await rememberSession(undefined);
              await clearDeviceStorage();
              window.dispatchEvent(new Event('satvey-auth-expired'));
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Mijn account verwijderen
        </Button>
      </div>
    </details>
  );
}
