import { useState } from 'react';
import { Button, Checkbox, Field } from '../components/ui';
import { api, json, uuid } from './api';
import type { HandoverDestination, HandoverSettingsData, Property } from './api';
import { useResource } from './useResource';
import { PropertyPicker } from './Properties';
import { DeliveryHistory } from './Handover';
import { SyncProfileEditor, SyncStatus } from './InternalSync';
import { errorText, ErrorNotice } from './shared';
import s from './workspace.module.css';

const newDestination = (): HandoverDestination => ({
  id: uuid(),
  name: '',
  enabled: false,
  revision: 0,
  secretConfigured: false,
  onderhoudUrl: '',
  dossierUrl: '',
  vastgoedUrl: '',
  tokenUrl: '',
  clientId: '',
  scopes: '',
  organisation: '',
  administration: 'SATVEY',
  reportTypeCode: '',
  maintenanceTypeCode: '',
});

export function HandoverSettings({ base, scope }: { base: string; scope: string }) {
  const { data, error, reload } = useResource<HandoverSettingsData>(
    scope,
    `${base}/handover-destinations`,
  );
  const [editing, setEditing] = useState<HandoverDestination>(),
    [secret, setSecret] = useState('');
  const [failure, setFailure] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [destination, setDestination] = useState(''),
    [property, setProperty] = useState<Property>(),
    [uri, setURI] = useState('');
  async function act(action: () => Promise<void>) {
    setFailure('');
    setNotice('');
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const fields: {
    key: keyof HandoverDestination;
    label: string;
    required?: boolean;
    type?: string;
  }[] = [
    { key: 'name', label: 'Naam ontvangend systeem', required: true },
    { key: 'onderhoudUrl', label: 'Aanvullende API-basis-URL (optioneel)', type: 'url' },
    { key: 'dossierUrl', label: 'Dossier API-basis-URL', required: true, type: 'url' },
    { key: 'vastgoedUrl', label: 'Vastgoed API-basis-URL (optioneel)', type: 'url' },
    { key: 'tokenUrl', label: 'OAuth2-token-URL', required: true, type: 'url' },
    { key: 'clientId', label: 'OAuth2-client-ID', required: true },
    { key: 'scopes', label: 'Afgesproken OAuth2-scopes' },
    { key: 'organisation', label: 'Bronorganisatie', required: true },
    { key: 'administration', label: 'Bronadministratie', required: true },
  ];
  return (
    <section className={s.stack} aria-label="VERA-synchronisatie">
      <div className={s.pageHeading}>
        <div>
          <h2>VERA-koppeling</h2>
          <p className={s.muted}>
            Configureer automatische interne synchronisatie van inspectiegegevens. De
            vastgoedkoppeling voor het ophalen van woningen blijft afzonderlijk.
          </p>
        </div>
        <Button
          disabled={busy}
          onClick={() => {
            setEditing(newDestination());
            setSecret('');
          }}
        >
          Bestemming toevoegen
        </Button>
      </div>
      {(error || failure) && <ErrorNotice>{error || failure}</ErrorNotice>}
      {notice && <p role="status">{notice}</p>}
      {!data && !error && <p role="status">VERA-bestemmingen laden…</p>}
      {data?.destinations.map((item) => (
        <article key={item.id} className={`${s.panel} ${s.stack}`}>
          <div className={s.reportToolbar}>
            <strong>{item.name}</strong>
            <span>{item.enabled ? 'Ingeschakeld' : 'Uitgeschakeld'}</span>
          </div>
          <p className={s.muted}>{item.onderhoudUrl}</p>
          <div className={s.actions}>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setEditing({ ...item });
                setSecret('');
              }}
            >
              Bestemming bewerken
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !item.enabled}
              onClick={() =>
                void act(async () => {
                  const result = await api<{ message: string }>(
                    `${base}/handover-destinations/${item.id}/test`,
                    json('POST', {}),
                  );
                  setNotice(result.message);
                })
              }
            >
              Basisverbinding testen
            </Button>
          </div>
          <SyncProfileEditor base={base} scope={scope} destination={item} />
        </article>
      ))}
      {data && !data.destinations.length && (
        <p>
          Voeg een interne VERA-bestemming toe en configureer welke gegevens automatisch
          gesynchroniseerd worden.
        </p>
      )}
      {editing && (
        <form
          className={`${s.panel} ${s.stack}`}
          aria-label="VERA-bestemming bewerken"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const saved = await api<HandoverDestination>(
                `${base}/handover-destinations`,
                json('PUT', { ...editing, secret }),
              );
              setEditing(saved);
              setSecret('');
              setNotice(
                'VERA-bestemming opgeslagen. Configureer de gegevenscategorie�n en controleer de synchronisatie.',
              );
              reload();
            });
          }}
        >
          <h3>{editing.revision ? 'Bestemming bewerken' : 'Bestemming toevoegen'}</h3>
          <p className={s.muted}>
            Profiel VERA 4.3.3: Onderhoud, Dossier en Vastgoed met OAuth2-client credentials. Stem
            schrijftoegang, bronidentiteit, codes en bestandslimieten met de leverancier af voordat
            je deze bestemming inschakelt.
          </p>
          <div className={s.twoColumns}>
            {fields.map((field) => (
              <Field
                key={field.key}
                label={field.label}
                aria-label={field.label}
                type={field.type}
                required={field.required}
                maxLength={field.key === 'name' ? 120 : 2000}
                disabled={busy}
                value={String(editing[field.key])}
                onChange={(e) => setEditing({ ...editing, [field.key]: e.target.value })}
              />
            ))}
          </div>
          <Field
            label={
              editing.secretConfigured
                ? 'Nieuw clientgeheim (leeg laten om te behouden)'
                : 'OAuth2-clientgeheim'
            }
            type="password"
            aria-label={
              editing.secretConfigured
                ? 'Nieuw clientgeheim (leeg laten om te behouden)'
                : 'OAuth2-clientgeheim'
            }
            autoComplete="new-password"
            required={!editing.secretConfigured}
            maxLength={8000}
            value={secret}
            disabled={busy}
            onChange={(e) => setSecret(e.target.value)}
          />
          <details>
            <summary>Afgesproken referentiecodes</summary>
            <div className={s.twoColumns}>
              <Field
                label="Code rapportsoort (optioneel)"
                maxLength={2000}
                value={editing.reportTypeCode}
                onChange={(e) => setEditing({ ...editing, reportTypeCode: e.target.value })}
              />
              <Field
                label="Code onderhoudsoort (optioneel)"
                maxLength={2000}
                value={editing.maintenanceTypeCode}
                onChange={(e) => setEditing({ ...editing, maintenanceTypeCode: e.target.value })}
              />
            </div>
          </details>
          <Checkbox
            label="Bestemming inschakelen"
            checked={editing.enabled}
            disabled={busy}
            onCheckedChange={(enabled) => setEditing({ ...editing, enabled })}
          />
          <p className={s.muted}>
            Configureer na het opslaan de gegevenscategorieën en test de leveranciersmogelijkheden.
            Geheimen worden versleuteld opgeslagen.
          </p>
          <div className={s.actions}>
            <Button type="submit" loading={busy}>
              Bestemming opslaan
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setEditing(undefined);
                setSecret('');
              }}
            >
              Bewerken sluiten
            </Button>
          </div>
        </form>
      )}
      {!!data?.destinations.length && (
        <section
          className={`${s.panel} ${s.stack}`}
          aria-label="Woning koppelen voor synchronisatie"
        >
          <h3>Woning koppelen voor synchronisatie</h3>
          <p>
            Bij een VERA-vastgoedbron met hetzelfde Vastgoed-endpoint wordt het bestaande
            ontvangende woningkenmerk gebruikt. Voor CSV-bronnen of andere doelsystemen leg je hier
            de gecontroleerde koppeling vast. Een adres is geen betrouwbare sleutel.
          </p>
          <label className={s.field}>
            <span>Bestemming voor woningkoppeling</span>
            <select
              aria-label="Bestemming voor woningkoppeling"
              value={destination}
              onChange={(e) => {
                setDestination(e.target.value);
                setURI('');
                setProperty(undefined);
              }}
            >
              <option value="">Kies een bestemming</option>
              {data.destinations
                .filter((item) => item.enabled)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          {destination && (
            <>
              <PropertyPicker
                base={base}
                scope={scope}
                selected={property?.id}
                state="linked"
                onSelect={setProperty}
                label="Zoek woning voor synchronisatie"
              />
              {property && (
                <>
                  <strong>Gekozen woning: {property.address}</strong>
                  <Field
                    label="Eenheid-URI in het ontvangende systeem"
                    type="url"
                    maxLength={2000}
                    value={uri}
                    onChange={(e) => setURI(e.target.value)}
                  />
                  <Button
                    disabled={busy || !uri}
                    onClick={() =>
                      void act(async () => {
                        await api(
                          `${base}/handover-destinations/${destination}/properties`,
                          json('PUT', { propertyId: property.id, unitUri: uri }),
                        );
                        setNotice('Ontvangende woning gecontroleerd en gekoppeld.');
                        setProperty(undefined);
                        setURI('');
                        reload();
                      })
                    }
                  >
                    Woningkoppeling controleren en opslaan
                  </Button>
                </>
              )}
            </>
          )}
          {data.mappings.map((mapping) => (
            <p key={`${mapping.destinationId}:${mapping.propertyId}`}>
              {mapping.address} →{' '}
              {data.destinations.find((item) => item.id === mapping.destinationId)?.name} ·{' '}
              {mapping.unitUri}
            </p>
          ))}
        </section>
      )}
      <SyncStatus base={base} scope={scope} admin />
      {data && data.deliveries.length > 0 && (
        <details>
          <summary>Eerdere overdrachten (historie)</summary>
          <DeliveryHistory deliveries={data.deliveries} />
        </details>
      )}
    </section>
  );
}
