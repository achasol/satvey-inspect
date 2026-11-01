import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '../components/ui';
import { api, json, type Dossier, type Media } from './api';
import { useResource } from './useResource';
import { announceRefresh, Select, ErrorNotice, errorText } from './shared';
import s from './workspace.module.css';

export function PhotoLocation({
  media,
  path,
  scope,
  disabled,
  onMoved,
}: {
  media: Media;
  path: string;
  scope: string;
  disabled: boolean;
  onMoved: () => void;
}) {
  const { data } = useResource<Dossier>(scope, path),
    [room, setRoom] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const batch = data?.batches.find((batch) => batch.id === media.batchId);
  return (
    <details className={s.photoLocation}>
      <summary>
        <Pencil size={16} /> Ruimte aanpassen
      </summary>
      <div className={s.stack}>
        <p>
          Verplaats deze foto naar de juiste ruimte. Betrokken beoordelingen worden opnieuw
          gecontroleerd.
        </p>
        <Select label="Doelruimte" value={room} onChange={setRoom}>
          <option value="">Kies een ruimte</option>
          {data?.rooms
            .filter((r) => r.id !== batch?.roomId)
            .map((r) => (
              <option value={r.id} key={r.id}>
                {r.name}
              </option>
            ))}
        </Select>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <Button
          variant="secondary"
          disabled={disabled || !batch || !room}
          loading={busy}
          onClick={async () => {
            if (!batch) return;
            setBusy(true);
            setError('');
            try {
              await api(
                `${path}/batches/${batch.id}/move`,
                json('POST', { roomId: room, mediaIds: [media.id], version: batch.version }),
              );
              announceRefresh();
              onMoved();
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Foto verplaatsen
        </Button>
        {disabled && <p>Bewaar eerst je fotomarkeringen.</p>}
      </div>
    </details>
  );
}
