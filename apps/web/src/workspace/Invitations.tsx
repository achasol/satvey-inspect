import { useState } from 'react';
import { Button } from '../components/ui';
import { api, json } from './api';
import { useResource } from './useResource';
import s from './workspace.module.css';

type Invitation = {
  id: string;
  email: string;
  expiresAt: string;
  delivery: 'manual' | 'pending' | 'processing' | 'done' | 'failed' | 'cancelled';
};
const labels = {
  manual: 'Link handmatig delen',
  pending: 'Wacht op verzending',
  processing: 'Wordt verzonden',
  done: 'E-mail verzonden',
  failed: 'Verzending mislukt',
  cancelled: 'Verzending geannuleerd',
};
export function Invitations({ base, scope }: { base: string; scope: string }) {
  const { data, error, reload } = useResource<Invitation[]>(scope, `${base}/invitations`);
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState('');
  async function resend(id: string) {
    setBusy(id);
    setFailure('');
    try {
      await api(`${base}/invitations/${id}/resend`, json('POST', {}));
      reload();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Verzending mislukt');
    } finally {
      setBusy('');
    }
  }
  return (
    <section className={s.stack} aria-label="Openstaande uitnodigingen">
      <h2>Openstaande uitnodigingen</h2>
      {(error || failure) && (
        <p role="alert" className={s.error}>
          {error || failure}
        </p>
      )}
      {data?.length === 0 && <p>Geen openstaande uitnodigingen.</p>}
      {data?.map((invitation) => (
        <div key={invitation.id} className={s.member}>
          <strong>{invitation.email}</strong>
          <span>
            {Date.parse(invitation.expiresAt) < Date.now()
              ? 'Verlopen'
              : labels[invitation.delivery]}
          </span>
          <Button
            variant="secondary"
            loading={busy === invitation.id}
            disabled={!!busy}
            onClick={() => void resend(invitation.id)}
          >
            Opnieuw uitnodigen
          </Button>
        </div>
      ))}
    </section>
  );
}
