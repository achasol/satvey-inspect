import { useId, useRef, useState } from 'react';
import { Image as ImageIcon, Upload, Trash2 } from 'lucide-react';
import { Button, Field } from '../components/ui';
import { api, json, uuid } from './api';
import { useResource } from './useResource';
import { organisationTheme } from './theme';
import { loadProtectedResource, protectedURL } from './platform';
import { announceRefresh, errorText, ErrorNotice } from './shared';
import s from './workspace.module.css';
type Identity = { tint?: string; name: string; logoAssetId: string | null; version: number };
export function ReportIdentity({ base, scope }: { base: string; scope: string }) {
  const { data, error } = useResource<Identity>(scope, `${base}/report-identity`);
  return (
    <>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {data && <IdentityForm key={data.version} base={base} initial={data} />}
    </>
  );
}
function IdentityForm({ base, initial }: { base: string; initial: Identity }) {
  const [name, setName] = useState(initial.name),
    [tint, setTint] = useState(initial.tint || ''),
    [logo, setLogo] = useState(initial.logoAssetId),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [logoName, setLogoName] = useState(''),
    [error, setError] = useState('');
  const logoInput = useRef<HTMLInputElement>(null),
    logoHeading = useId(),
    logoHint = useId();
  return (
    <form
      className={`${s.panel} ${s.stack} ${s.identityForm}`}
      onSubmit={async (e) => {
        e.preventDefault();
        if (uploading) return;
        setBusy(true);
        setError('');
        try {
          await api(
            `${base}/report-identity`,
            json('PUT', { name, logoAssetId: logo, tint, version: initial.version }),
          );
          announceRefresh();
          window.dispatchEvent(new Event('satvey-auth-changed'));
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Organisatie en huisstijl</h3>
      <p>
        Nieuwe rapporten gebruiken deze naam en dit logo. Definitieve rapporten blijven ongewijzigd.
      </p>
      <Field
        label="Organisatienaam op rapport"
        value={name}
        maxLength={160}
        onChange={(e) => setName(e.target.value)}
      />
      <div className={`${s.stack} ${s.identityPreview}`} style={organisationTheme(tint)}>
        <label className={s.field}>
          <span>Organisatiekleur</span>
          <input type="color" value={tint || '#536044'} onChange={(e) => setTint(e.target.value)} />
        </label>
        <div className={s.actions}>
          {['#536044', '#28657a', '#735487', '#a04e36', '#276b59'].map((colour) => (
            <button
              type="button"
              key={colour}
              aria-label={`Kleur ${colour}`}
              aria-pressed={tint === colour}
              style={{
                background: colour,
                width: 40,
                height: 40,
                borderRadius: 8,
                border: tint === colour ? '3px solid var(--text)' : '1px solid var(--border)',
              }}
              onClick={() => setTint(colour)}
            />
          ))}
        </div>
        <Button variant="secondary" onClick={() => setTint('')}>
          Satvey-kleur herstellen
        </Button>
        <p className={s.muted}>
          Knoppen en actieve onderdelen gebruiken een leesbare tint; statuskleuren blijven
          herkenbaar.
        </p>
        <Button type="button">Voorbeeldknop</Button>
      </div>
      <section className={s.identityLogo} aria-labelledby={logoHeading}>
        <h4 id={logoHeading}>Organisatielogo</h4>
        <div className={s.logoUpload}>
          <div className={s.logoPreview}>
            {logo ? (
              <img src={protectedURL(`/api/v1${base}/norm-assets/${logo}`)} alt="Organisatielogo" />
            ) : (
              <>
                <ImageIcon size={28} aria-hidden="true" />
                <span>Logo-preview</span>
              </>
            )}
          </div>
          <div className={s.logoUploadControls}>
            <div className={s.actions}>
              <Button
                type="button"
                variant="secondary"
                icon={<Upload size={16} />}
                disabled={busy}
                loading={uploading}
                aria-describedby={logoHint}
                onClick={() => logoInput.current?.click()}
              >
                {logo ? 'Logo vervangen' : 'Logo kiezen'}
              </Button>
              {logo && (
                <Button
                  type="button"
                  variant="ghost"
                  icon={<Trash2 size={16} />}
                  disabled={busy || uploading}
                  onClick={() => {
                    setLogo(null);
                    setLogoName('');
                    setError('');
                  }}
                >
                  Logo verwijderen
                </Button>
              )}
            </div>
            <p className={s.muted} id={logoHint}>
              JPG, PNG of WebP · maximaal 1 MiB.
            </p>
            {logoName && (
              <p className={s.logoFileName} role="status">
                {logoName}
              </p>
            )}
          </div>
        </div>
        <input
          ref={logoInput}
          hidden
          type="file"
          aria-label="Organisatielogo uploaden"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy || uploading}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            setUploading(true);
            setError('');
            try {
              if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
                throw new Error('Kies een JPG, PNG of WebP-afbeelding.');
              if (file.size > 1048576) throw new Error('Maximaal 1 MiB per logo.');
              const id = uuid();
              await api(`${base}/norm-assets/${id}`, {
                method: 'PUT',
                headers: {
                  'Content-Type': file.type,
                  'X-File-Name': encodeURIComponent(file.name),
                },
                body: file,
              });
              await loadProtectedResource(`/api/v1${base}/norm-assets/${id}`);
              setLogo(id);
              setLogoName(file.name);
            } catch (error) {
              setError(errorText(error));
            } finally {
              setUploading(false);
            }
          }}
        />
      </section>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <Button type="submit" loading={busy} disabled={uploading}>
        Rapportidentiteit bewaren
      </Button>
    </form>
  );
}
