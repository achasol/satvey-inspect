import { networkOnline } from './connectivity';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui';
import { prepareVisit, preparedVisits, removePreparedVisit } from './offline';
import type { PreparedVisit } from './offline';
import { nativeDevice } from './nativeStorage';
import { errorText, ErrorNotice } from './shared';
import s from './workspace.module.css';
export function PrepareOffline({ scope, path }: { scope: string; path: string }) {
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  if (!nativeDevice) return null;
  return (
    <div>
      <Button
        variant="secondary"
        disabled={!networkOnline()}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await prepareVisit(scope, path, setNotice);
          } catch (e) {
            setError(errorText(e));
            setNotice('');
          } finally {
            setBusy(false);
          }
        }}
      >
        Voor offline gebruik voorbereiden
      </Button>
      {notice && <p role="status">{notice}</p>}
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </div>
  );
}
export function OfflineVisits({ scope }: { scope: string }) {
  const [items, setItems] = useState<PreparedVisit[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    void preparedVisits(scope)
      .then(setItems)
      .catch((e) => setError(errorText(e)));
  }, [scope]);
  return (
    <section className={s.stack}>
      <h1>Inspecties op dit apparaat</h1>
      <p>
        AI-verwerking, vastleggen en verzending vereisen verbinding. Niet-gesynchroniseerd werk
        blijft bewaard.
      </p>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {items.map((i) => (
        <article key={i.id} className={s.panel}>
          <Link to={`/app/inspections/${i.id}/capture`}>{i.address}</Link>
          <p>
            {(i.bytes / 1048576).toFixed(1)} MiB · toegang tot{' '}
            {new Date(i.expiresAt).toLocaleString('nl-NL')}
          </p>
          {networkOnline() && (
            <Button
              variant="ghost"
              onClick={async () => {
                try {
                  await removePreparedVisit(scope, i);
                  setItems(await preparedVisits(scope));
                } catch (e) {
                  setError(errorText(e));
                }
              }}
            >
              Offline kopie verwijderen
            </Button>
          )}
        </article>
      ))}
      {!items.length && <p>Bereid inspecties voor terwijl je verbinding hebt.</p>}
    </section>
  );
}
