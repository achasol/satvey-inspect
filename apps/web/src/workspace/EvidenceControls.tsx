import { useState } from 'react';
import { Button, Dialog, Field, IconButton } from '../components/ui';
import { Pencil } from 'lucide-react';
import { api, json } from './api';
import type { Batch, Dossier, Room } from './types';
import { announceRefresh, errorText, ErrorNotice, Select } from './shared';
import s from './workspace.module.css';
export function RenameRoom({ room, path }: { room: Room; path: string }) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(room.name),
    [generation, setGeneration] = useState(room.generation),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <>
      <IconButton
        label={`Naam wijzigen: ${room.name}`}
        title={`Naam wijzigen: ${room.name}`}
        className={s.roomRename}
        onClick={() => {
          setName(room.name);
          setGeneration(room.generation);
          setError('');
          setOpen(true);
        }}
      >
        <Pencil size={16} />
      </IconButton>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
        title="Ruimtenaam wijzigen"
        description="Geef deze ruimte een herkenbare naam."
        closeLabel="Sluiten"
      >
        <form
          className={s.stack}
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            try {
              await api(`${path}/rooms/${room.id}`, json('PUT', { name: name.trim(), generation }));
              setOpen(false);
              announceRefresh();
            } catch (error) {
              setError(errorText(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field
            label="Ruimtenaam"
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            required
            autoFocus
            disabled={busy}
          />
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <div className={s.actions}>
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              Annuleren
            </Button>
            <Button
              type="submit"
              loading={busy}
              disabled={!name.trim() || name.trim() === room.name}
            >
              Opslaan
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
export function MoveEvidence({ batch, data, path }: { batch: Batch; data: Dossier; path: string }) {
  const [room, setRoom] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <details>
      <summary>Bronbestanden naar andere ruimte verplaatsen</summary>
      <form
        className={s.stack}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api(
              `${path}/batches/${batch.id}/move`,
              json('POST', { roomId: room, mediaIds: selected, version: batch.version }),
            );
            setSelected([]);
            setRoom('');
            announceRefresh();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          De bronbestanden blijven behouden. Betrokken bevindingen en ruimtes moeten opnieuw worden
          beoordeeld.
        </p>
        <fieldset>
          <legend>Bestanden verplaatsen</legend>
          {data.media
            .filter((m) => m.batchId === batch.id && !m.contentDeletedAt)
            .map((m) => (
              <label key={m.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(m.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? [...selected, m.id] : selected.filter((id) => id !== m.id),
                    )
                  }
                />
                {m.name}
              </label>
            ))}
        </fieldset>
        <Select label="Doelruimte" value={room} onChange={setRoom}>
          <option value="">Kies een ruimte</option>
          {data.rooms
            .filter((r) => r.id !== batch.roomId)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </Select>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <Button type="submit" loading={busy} disabled={!room || !selected.length}>
          Geselecteerde bestanden verplaatsen
        </Button>
      </form>
    </details>
  );
}
