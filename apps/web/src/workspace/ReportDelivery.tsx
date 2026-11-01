import { useRef, useState } from 'react';
import { Button, Field } from '../components/ui';
import { api, json, uuid } from './api';
import { useResource } from './useResource';
import { announceRefresh, errorText, ErrorNotice } from './shared';
import s from './workspace.module.css';
type Delivery = {
  id: string;
  reportId: string;
  recipient: string;
  createdAt: string;
  status: string;
  error: string;
};
export function ReportDelivery({
  path,
  scope,
  reportId,
  canWrite,
}: {
  path: string;
  scope: string;
  reportId: string;
  canWrite: boolean;
}) {
  const { data } = useResource<Delivery[]>(scope, `${path}/report/deliveries`);
  const [recipient, setRecipient] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const requestID = useRef(uuid());
  return (
    <details className={s.panel}>
      <summary>Rapport per e-mail versturen</summary>
      <div className={s.stack}>
        <p>
          De definitieve PDF wordt als bijlage verstuurd. Een geaccepteerde verzending is geen
          bewijs dat de bewoner de e-mail heeft ontvangen of gelezen.
        </p>
        {canWrite && (
          <form
            className={s.stack}
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              setNotice('');
              try {
                await api(
                  `${path}/report/email`,
                  json('POST', { id: requestID.current, recipient, reportId }),
                );
                requestID.current = uuid();
                setConfirmed(false);
                setNotice('Verzending in wachtrij. Volg hieronder de verzendstatus.');
                announceRefresh();
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field
              label="E-mailadres ontvanger"
              type="email"
              value={recipient}
              required
              onChange={(e) => {
                setRecipient(e.target.value);
                setConfirmed(false);
                requestID.current = uuid();
              }}
            />
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />{' '}
              Ik heb het e-mailadres en de rapportversie gecontroleerd.
            </label>
            {error && <ErrorNotice>{error}</ErrorNotice>}
            {notice && <p role="status">{notice}</p>}
            <Button type="submit" disabled={!confirmed || !recipient.trim()} loading={busy}>
              PDF versturen
            </Button>
          </form>
        )}
        {data?.map((d) => (
          <article key={d.id}>
            <strong>{d.recipient}</strong>
            <p>
              {new Date(d.createdAt).toLocaleString('nl-NL')} ·{' '}
              {(
                {
                  accepted: 'Door mailserver geaccepteerd',
                  pending: 'In wachtrij',
                  processing: 'Wordt verstuurd',
                  failed: 'Mislukt',
                  uncertain: 'Verzending onzeker',
                  cancelled: 'Geannuleerd',
                } as Record<string, string>
              )[d.status] || d.status}
            </p>
            {d.error && <ErrorNotice>{d.error}</ErrorNotice>}
            {canWrite && (
              <Button
                variant="secondary"
                onClick={() => {
                  requestID.current = uuid();
                  setRecipient(d.recipient);
                  setConfirmed(false);
                }}
              >
                Opnieuw voorbereiden
              </Button>
            )}
          </article>
        ))}
      </div>
    </details>
  );
}
