import { useRef, useState } from 'react';
import { Button, Field } from '../components/ui';
import { api, json, uuid } from './api';
import { useResource } from './useResource';
import { announceRefresh, errorText, ErrorNotice } from './shared';
import s from './workspace.module.css';
type Record = {
  id: string;
  recipient: string;
  channel: string;
  reference: string;
  note: string;
  acknowledged: boolean;
  createdAt: string;
};
export function ManualHandover({
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
  const { data } = useResource<Record[]>(scope, `${path}/manual-handovers`);
  const [recipient, setRecipient] = useState(''),
    [channel, setChannel] = useState(''),
    [reference, setReference] = useState(''),
    [note, setNote] = useState(''),
    [acknowledged, setAcknowledged] = useState(false),
    [reconciliation, setReconciliation] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const request = useRef(uuid());
  return (
    <details className={s.panel}>
      <summary>Handmatige overdracht registreren</summary>
      <div className={s.stack}>
        <p>
          Registreer een overdracht via het afgesproken klantkanaal. Deze registratie verstuurt zelf
          geen bestanden en is geen opdracht tot uitvoering.
        </p>
        {canWrite && (
          <form
            className={s.stack}
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                await api(
                  `${path}/manual-handovers`,
                  json('POST', {
                    id: request.current,
                    reportId,
                    recipient,
                    channel,
                    reference,
                    note,
                    acknowledged,
                    reconciliation,
                  }),
                );
                request.current = uuid();
                setReference('');
                setNote('');
                setAcknowledged(false);
                announceRefresh();
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field
              label="Ontvangende afdeling of organisatie"
              value={recipient}
              required
              maxLength={240}
              onChange={(e) => setRecipient(e.target.value)}
            />
            <Field
              label="Gebruikt kanaal"
              value={channel}
              required
              maxLength={100}
              onChange={(e) => setChannel(e.target.value)}
            />
            <Field
              label="Ontvangend zaak- of dossierkenmerk"
              value={reference}
              required
              maxLength={240}
              onChange={(e) => setReference(e.target.value)}
            />
            <Field
              label="Toelichting overdracht"
              value={note}
              maxLength={4000}
              onChange={(e) => setNote(e.target.value)}
            />
            <label>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />{' '}
              De ontvanger heeft ontvangst bevestigd.
            </label>
            <Field
              label="Afstemming bij onvolledige VERA-overdracht (beheerder)"
              value={reconciliation}
              maxLength={4000}
              onChange={(e) => setReconciliation(e.target.value)}
            />
            <p>
              Bij een onvolledige VERA-overdracht moet een beheerder eerst controleren welke
              onderdelen al zijn ontvangen en deze afstemming vastleggen.
            </p>
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <Button type="submit" loading={busy}>
              Handmatige overdracht vastleggen
            </Button>
          </form>
        )}
        {data?.map((d) => (
          <article key={d.id}>
            <strong>
              {d.recipient} · {d.reference}
            </strong>
            <p>
              {d.channel} · {new Date(d.createdAt).toLocaleString('nl-NL')} ·{' '}
              {d.acknowledged
                ? 'Ontvangst bevestigd'
                : 'Overgedragen, ontvangst nog niet bevestigd'}
            </p>
            <p>{d.note}</p>
          </article>
        ))}
      </div>
    </details>
  );
}
