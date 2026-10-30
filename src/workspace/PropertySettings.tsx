import { useState } from 'react';
import { Badge, Button, Dialog, Field } from '../components/ui';
import { api, json, uuid } from './api';
import type { Property, PropertyImport, PropertySource, PropertySourceData } from './api';
import { useResource } from './useResource';
import { PropertyFacts, PropertyPicker, propertyDate } from './Properties';
import s from './workspace.module.css';
import p from './properties.module.css';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
type SourceForm = Pick<
  PropertySource,
  | 'id'
  | 'name'
  | 'administration'
  | 'kind'
  | 'baseUrl'
  | 'tokenUrl'
  | 'authKind'
  | 'clientId'
  | 'scopes'
  | 'enabled'
  | 'revision'
> & { secret: string };
const newSource = (): SourceForm => ({
  id: uuid(),
  name: '',
  administration: '',
  kind: 'csv',
  baseUrl: '',
  tokenUrl: '',
  authKind: 'api_key',
  clientId: '',
  scopes: '',
  enabled: true,
  revision: 0,
  secret: '',
});

export function PropertySettings({ base, scope }: { base: string; scope: string }) {
  const {
    data,
    error: loadError,
    reload,
  } = useResource<PropertySourceData>(scope, `${base}/property-sources`);
  const [form, setForm] = useState<SourceForm>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [importSource, setImportSource] = useState<PropertySource>(),
    [csvText, setCSVText] = useState(''),
    [preview, setPreview] = useState<PropertyImport>(),
    [importConfirmed, setImportConfirmed] = useState(false),
    [provisional, setProvisional] = useState<Property>(),
    [target, setTarget] = useState<Property>();
  const refresh = () => {
    reload();
    window.dispatchEvent(new Event('satvey-refresh'));
  };
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!form) return;
    await api(
      `${base}/property-sources${form.revision ? `/${form.id}` : ''}`,
      json(form.revision ? 'PUT' : 'POST', form),
    );
    setForm(undefined);
    setNotice('Vastgoedbron bewaard.');
    refresh();
  }
  async function validateImport() {
    if (!importSource) return;
    const result = await api<PropertyImport>(
      `${base}/property-sources/${importSource.id}/imports`,
      json('POST', { csv: csvText }),
    );
    setPreview(result);
    setImportConfirmed(false);
  }
  async function confirmImport() {
    if (!preview?.id || !importSource) return;
    await api(
      `${base}/property-sources/${importSource.id}/imports/${preview.id}/confirm`,
      json('POST', {}),
    );
    setImportConfirmed(true);
    setNotice(`${preview.rows} woningen verwerkt.`);
    refresh();
  }
  async function link() {
    if (!provisional || !target) return;
    await api(
      `${base}/properties/${provisional.id}/link`,
      json('POST', {
        targetPropertyId: target.id,
        revision: provisional.revision,
        targetRevision: target.revision,
      }),
    );
    setProvisional(undefined);
    setTarget(undefined);
    setNotice(
      'Bronkoppeling bevestigd. Betrokken conceptinspecties gebruiken de bronwoning en worden opnieuw beoordeeld.',
    );
    refresh();
  }
  return (
    <section className={s.stack} aria-label="Vastgoedkoppeling">
      <div className={p.sourceHeader}>
        <div>
          <h2>Vastgoedkoppeling</h2>
          <p className={s.muted}>
            Beheer de woningcatalogus en bevestig de identiteit van voorlopige woningen.
          </p>
        </div>
        <Button
          onClick={() => {
            setError('');
            setForm(newSource());
          }}
        >
          Vastgoedbron toevoegen
        </Button>
      </div>
      {(error || loadError) && (
        <p className={s.error} role="alert">
          {error || loadError}
        </p>
      )}
      {notice && (
        <p role="status" className={s.success}>
          {notice}
        </p>
      )}
      {!data && !loadError && <p>Bronnen laden…</p>}
      {data?.sources.length === 0 && (
        <p className={s.muted}>
          Voeg een CSV-bron of VERA-koppeling toe om woningen beschikbaar te maken.
        </p>
      )}
      {data?.sources.map((source) => {
        const running = data.jobs.find(
          (j) => j.sourceId === source.id && ['pending', 'processing'].includes(j.status),
        );
        return (
          <article key={source.id} className={p.source}>
            <div className={p.sourceHeader}>
              <h3>{source.name}</h3>
              <Badge tone={source.enabled ? 'neutral' : 'warning'}>
                {source.kind === 'vera' ? 'VERA' : 'CSV'} ·{' '}
                {source.enabled ? 'Actief' : 'Uitgeschakeld'}
              </Badge>
            </div>
            <p>
              {source.administration}
              {source.kind === 'vera' ? ` · ${source.baseUrl}` : ''}
            </p>
            <p className={s.muted}>
              Laatste volledige aanlevering: {propertyDate(source.lastSyncedAt)}
              {source.kind === 'vera' && source.enabled
                ? ' · automatische synchronisatie ieder uur'
                : ''}
            </p>
            {source.lastError && <p className={s.error}>{source.lastError}</p>}
            {running && (
              <p role="status">
                {running.status === 'processing' ? 'Bezig met ophalen' : 'Synchronisatie ingepland'}{' '}
                · {running.processed} woningen verwerkt
              </p>
            )}
            <div className={s.actions}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setError('');
                  setForm({
                    id: source.id,
                    name: source.name,
                    administration: source.administration,
                    kind: source.kind,
                    baseUrl: source.baseUrl,
                    tokenUrl: source.tokenUrl,
                    authKind: source.authKind,
                    clientId: source.clientId,
                    scopes: source.scopes,
                    enabled: source.enabled,
                    revision: source.revision,
                    secret: '',
                  });
                }}
              >
                Bron bewerken
              </Button>
              {source.enabled && source.kind === 'vera' && (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const result = await api<{ sampleCount: number }>(
                          `${base}/property-sources/${source.id}/test`,
                          json('POST', {}),
                        );
                        setNotice(
                          `Verbinding geslaagd: ${result.sampleCount} woningen op de testpagina. Deze test wijzigt de catalogus niet.`,
                        );
                      })
                    }
                  >
                    Verbinding testen
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || !!running}
                    onClick={() =>
                      void act(async () => {
                        await api(`${base}/property-sources/${source.id}/sync`, json('POST', {}));
                        setNotice('Synchronisatie gestart.');
                        refresh();
                      })
                    }
                  >
                    Nu synchroniseren
                  </Button>
                </>
              )}
              {source.enabled && source.kind === 'csv' && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setError('');
                    setImportSource(source);
                    setCSVText('');
                    setPreview(undefined);
                    setImportConfirmed(false);
                  }}
                >
                  CSV importeren
                </Button>
              )}
            </div>
          </article>
        );
      })}
      {!!data?.jobs.length && (
        <details>
          <summary>Recente synchronisaties</summary>
          <div style={{ overflowX: 'auto' }}>
            <table className={p.table}>
              <thead>
                <tr>
                  <th>Bron</th>
                  <th>Status</th>
                  <th>Woningen</th>
                  <th>Toelichting</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      {job.sourceName}
                      <br />
                      <small>{propertyDate(job.createdAt)}</small>
                    </td>
                    <td>
                      {{
                        pending: 'Ingepland',
                        processing: 'Bezig',
                        done: 'Gereed',
                        failed: 'Mislukt',
                      }[job.status] || job.status}
                    </td>
                    <td>{job.processed}</td>
                    <td>
                      {job.error ||
                        (job.propertyId ? 'Eén woning verversen' : 'Catalogus synchroniseren')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <details>
        <summary>Catalogus bekijken</summary>
        <PropertyPicker
          base={base}
          scope={scope}
          onSelect={(item) => {
            setError('');
            setTarget(undefined);
            setProvisional(item);
          }}
          label="Zoek woning in catalogus"
        />
      </details>
      <section className={s.stack}>
        <h3>Voorlopige woningen koppelen</h3>
        <p className={s.muted}>
          Vergelijk adres en objectnummer. Bevestigen koppelt alle conceptinspecties van de
          voorlopige woning aan de gekozen bronwoning en neemt de brongegevens over.
        </p>
        <PropertyPicker
          base={base}
          scope={scope}
          state="provisional"
          label="Zoek voorlopige woning"
          onSelect={(item) => {
            setError('');
            setTarget(undefined);
            setProvisional(item);
          }}
        />
      </section>
      <Dialog
        closeLabel="Sluiten"
        open={!!form}
        onOpenChange={(open) => {
          if (!open) setForm(undefined);
        }}
        title={form?.revision ? 'Vastgoedbron bewerken' : 'Vastgoedbron toevoegen'}
        description="Iedere bron heeft één vaste administratie en aanleverroute."
      >
        {form && (
          <form
            className={s.stack}
            onSubmit={(e) => {
              e.preventDefault();
              void act(save);
            }}
          >
            <Field
              label="Naam vastgoedbron"
              required
              maxLength={120}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Field
              label="Bronadministratie"
              required
              readOnly={!!form.revision}
              maxLength={160}
              hint="Een vaste, herkenbare code voor deze administratie."
              value={form.administration}
              onChange={(e) => setForm({ ...form, administration: e.target.value })}
            />
            <label className={s.field}>
              <span>Aanleverroute</span>
              <select
                aria-label="Aanleverroute"
                disabled={!!form.revision}
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value as 'csv' | 'vera' })}
              >
                <option value="csv">CSV-import</option>
                <option value="vera">VERA API</option>
              </select>
            </label>
            {form.kind === 'vera' && (
              <>
                <Field
                  label="VERA basis-URL"
                  type="url"
                  required
                  maxLength={2000}
                  placeholder="https://vastgoed.voorbeeld.nl/v4"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                />
                <label className={s.field}>
                  <span>Authenticatie</span>
                  <select
                    aria-label="Authenticatie"
                    value={form.authKind}
                    onChange={(e) =>
                      setForm({ ...form, authKind: e.target.value as 'api_key' | 'oauth2' })
                    }
                  >
                    <option value="api_key">API-key (X-API-KEY)</option>
                    <option value="oauth2">OAuth2 client credentials</option>
                  </select>
                </label>
                {form.authKind === 'oauth2' && (
                  <>
                    <Field
                      label="OAuth2 token-URL"
                      type="url"
                      required
                      maxLength={2000}
                      value={form.tokenUrl}
                      onChange={(e) => setForm({ ...form, tokenUrl: e.target.value })}
                    />
                    <Field
                      label="Client-ID"
                      required
                      maxLength={512}
                      value={form.clientId}
                      onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                    />
                    <Field
                      label="Scopes"
                      maxLength={2000}
                      hint="Gebruik de door de leverancier opgegeven leesscopes."
                      value={form.scopes}
                      onChange={(e) => setForm({ ...form, scopes: e.target.value })}
                    />
                  </>
                )}
                <Field
                  label={form.authKind === 'oauth2' ? 'Client secret' : 'API-key'}
                  type="password"
                  autoComplete="new-password"
                  required={!form.revision}
                  maxLength={8000}
                  hint={
                    form.revision ? 'Leeg laten om de bestaande sleutel te behouden.' : undefined
                  }
                  value={form.secret}
                  onChange={(e) => setForm({ ...form, secret: e.target.value })}
                />
              </>
            )}
            <label>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />{' '}
              Bron ingeschakeld
            </label>
            {error && (
              <p className={s.error} role="alert">
                {error}
              </p>
            )}
            <Button type="submit" loading={busy}>
              Vastgoedbron bewaren
            </Button>
          </form>
        )}
      </Dialog>
      <Dialog
        closeLabel="Sluiten"
        open={!!importSource}
        onOpenChange={(open) => {
          if (!open) setImportSource(undefined);
        }}
        title={`CSV importeren${importSource ? ` · ${importSource.name}` : ''}`}
        description="Valideer het bestand en controleer de wijzigingen vóór bevestiging. Ontbrekende woningen worden niet verwijderd."
      >
        <div className={s.stack}>
          <a href={`/api/v1${base}/property-import-template`} download="satvey-vastgoed.csv">
            CSV-sjabloon downloaden
          </a>
          <label className={s.field}>
            <span>CSV-bestand</span>
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={async (e) => {
                setPreview(undefined);
                setImportConfirmed(false);
                setError('');
                const file = e.target.files?.[0];
                setCSVText('');
                if (file) {
                  if (file.size > 750000) {
                    setError(
                      'Gebruik een CSV-bestand van maximaal 750 kB; splits grotere bestanden.',
                    );
                    return;
                  }
                  try {
                    setCSVText(await file.text());
                  } catch (err) {
                    setError(message(err));
                  }
                }
              }}
            />
          </label>
          <p className={s.muted}>
            Gebruik het UTF-8-sjabloon met komma’s. Bronobject-ID en adres zijn verplicht. Gebruik
            een decimale punt voor oppervlaktes en vermeld meetsoort en eenheid.
          </p>
          <Button
            variant="secondary"
            disabled={!csvText || busy}
            onClick={() => void act(validateImport)}
          >
            Bestand valideren
          </Button>
          {preview && (
            <>
              {preview.errors.length > 0 ? (
                <ul role="alert" className={s.error}>
                  {preview.errors.map((value, index) => (
                    <li key={index}>{value}</li>
                  ))}
                </ul>
              ) : (
                <>
                  <p>
                    {preview.rows} woningen: {preview.created} nieuw, {preview.updated} gewijzigd,{' '}
                    {preview.unchanged} ongewijzigd.
                  </p>
                  {preview.changes?.map((change, index) => (
                    <details key={index}>
                      <summary>
                        {change.after.objectNumber || change.after.sourceObjectId} ·{' '}
                        {change.after.address} · {change.before ? 'Wijzigen' : 'Nieuw'}
                      </summary>
                      <div className={p.comparison}>
                        <section>
                          <h4>Huidig</h4>
                          {change.before ? (
                            <PropertyFacts property={change.before} />
                          ) : (
                            <p>Nieuwe woning</p>
                          )}
                        </section>
                        <section>
                          <h4>Na import</h4>
                          <PropertyFacts property={change.after} />
                        </section>
                      </div>
                    </details>
                  ))}
                  {preview.changesTruncated && (
                    <p className={s.muted}>
                      De eerste 100 wijzigingen worden getoond. Splits het bestand om alle
                      wijzigingen afzonderlijk te controleren.
                    </p>
                  )}
                  {importConfirmed ? (
                    <p role="status" className={s.success}>
                      Import bevestigd.
                    </p>
                  ) : (
                    <Button loading={busy} onClick={() => void act(confirmImport)}>
                      Import bevestigen
                    </Button>
                  )}
                </>
              )}
            </>
          )}
          {error && (
            <p className={s.error} role="alert">
              {error}
            </p>
          )}
        </div>
      </Dialog>
      <Dialog
        closeLabel="Sluiten"
        open={!!provisional}
        onOpenChange={(open) => {
          if (!open) {
            setProvisional(undefined);
            setTarget(undefined);
          }
        }}
        title={
          provisional?.linkState === 'provisional' ? 'Voorlopige woning koppelen' : 'Woninggegevens'
        }
        description={
          provisional?.linkState === 'provisional'
            ? 'Controleer de objectidentiteit. De koppeling geldt voor alle conceptinspecties van deze woning.'
            : 'Administratieve kenmerken uit de woningcatalogus.'
        }
      >
        {provisional && (
          <div className={s.stack}>
            <PropertyFacts property={provisional} />
            {provisional.linkState === 'provisional' && (
              <>
                <PropertyPicker
                  base={base}
                  scope={scope}
                  state="linked"
                  label="Zoek bronwoning"
                  selected={target?.id}
                  onSelect={setTarget}
                />
                {target && (
                  <section>
                    <h3>Gekozen bronwoning</h3>
                    <PropertyFacts property={target} />
                    <p className={s.warning}>
                      Bevestigen neemt deze gegevens over in de betrokken conceptinspecties en
                      vraagt herbeoordeling.
                    </p>
                    <Button loading={busy} onClick={() => void act(link)}>
                      Bronkoppeling bevestigen
                    </Button>
                  </section>
                )}
              </>
            )}
            {error && (
              <p className={s.error} role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </Dialog>
    </section>
  );
}
