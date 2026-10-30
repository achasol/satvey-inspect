import { useState } from 'react';
import { Button, Checkbox, Dialog, Field, Badge } from '../components/ui';
import { api, json } from './api';
import { useResource } from './useResource';
import s from './workspace.module.css';

export type OrgRole = {
  id: string;
  name: string;
  description: string;
  privileges: string[];
  systemKey: string | null;
  version: number;
  memberCount: number;
  invitationCount: number;
};
export type RolesData = {
  roles: OrgRole[];
  privileges: { key: string; label: string; description: string; group: string }[];
};
export function RoleSettings({ base, scope }: { base: string; scope: string }) {
  const { data, error, reload } = useResource<RolesData>(scope, `${base}/roles`);
  const [editing, setEditing] = useState<OrgRole | null | undefined>(),
    [failure, setFailure] = useState('');
  return (
    <section className={s.panel} style={{ gridColumn: '1 / -1' }} aria-label="Rollen en privileges">
      <div className={s.pageHeading}>
        <div>
          <h2>Rollen en privileges</h2>
          <p className={s.muted}>
            Rechten gelden binnen deze organisatie. Rollen kunnen zelf worden samengesteld.
          </p>
        </div>
        <Button onClick={() => setEditing(null)}>Rol toevoegen</Button>
      </div>
      {(error || failure) && (
        <p className={s.error} role="alert">
          {error || failure}
        </p>
      )}
      {data?.roles.map((role) => (
        <div key={role.id} className={s.roleRow}>
          <div>
            <strong>{role.name}</strong>
            <p className={s.muted}>{role.description}</p>
            <div className={s.actions}>
              {role.privileges.map((p) => (
                <Badge key={p}>{data.privileges.find((v) => v.key === p)?.label || p}</Badge>
              ))}
              {!role.privileges.length && <Badge>Geen privileges</Badge>}
            </div>
          </div>
          <div className={s.actions}>
            <small>
              {role.memberCount} leden
              {role.invitationCount > 0 && ` / ${role.invitationCount} uitnodigingen`}
            </small>
            <Button size="sm" variant="secondary" onClick={() => setEditing(role)}>
              Rol bewerken
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={role.memberCount > 0 || role.invitationCount > 0}
              onClick={async () => {
                if (!window.confirm(`Rol ${role.name} verwijderen?`)) return;
                try {
                  await api(`${base}/roles/${role.id}`, { method: 'DELETE' });
                  reload();
                } catch (e) {
                  setFailure(String(e));
                }
              }}
            >
              Verwijderen
            </Button>
          </div>
        </div>
      ))}
      {editing !== undefined && data && (
        <RoleEditor
          key={editing?.id || 'new'}
          base={base}
          role={editing}
          catalog={data.privileges}
          onClose={() => setEditing(undefined)}
          onSave={() => {
            setEditing(undefined);
            reload();
            window.dispatchEvent(new Event('satvey-auth-changed'));
            window.dispatchEvent(new Event('satvey-refresh'));
          }}
        />
      )}
    </section>
  );
}
function RoleEditor({
  base,
  role,
  catalog,
  onClose,
  onSave,
}: {
  base: string;
  role: OrgRole | null;
  catalog: RolesData['privileges'];
  onClose: () => void;
  onSave: () => void;
}) {
  const [name, setName] = useState(role?.name || ''),
    [description, setDescription] = useState(role?.description || ''),
    [selected, setSelected] = useState(role?.privileges || []),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  function toggle(key: string, checked: boolean) {
    setSelected((current) => {
      let next = checked ? [...current, key] : current.filter((p) => p !== key);
      const dependencies: Record<string, string> = {
        'inspections.write': 'inspections.read',
        'formats.manage': 'formats.read',
        'norms.manage': 'norms.read',
        'benchmarks.read': 'norms.read',
      };
      if (checked && dependencies[key] && !next.includes(dependencies[key]))
        next.push(dependencies[key]);
      if (!checked) next = next.filter((p) => dependencies[p] !== key);
      if (checked && key === 'formats.manage' && !next.includes('norms.read'))
        next.push('norms.read');
      if (!checked && key === 'norms.read') next = next.filter((p) => p !== 'formats.manage');
      return next;
    });
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={role ? 'Rol bewerken' : 'Rol toevoegen'}
      description="Selecteer welke handelingen deze rol mag uitvoeren."
      closeLabel="Sluiten"
      fullOnMobile
    >
      <form
        className={s.stack}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api(
              role ? `${base}/roles/${role.id}` : `${base}/roles`,
              json(role ? 'PUT' : 'POST', {
                name,
                description,
                privileges: selected,
                version: role?.version || 0,
              }),
            );
            onSave();
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Opslaan mislukt');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field
          label="Rolnaam"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          label="Omschrijving"
          maxLength={1000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {Array.from(new Set(catalog.map((p) => p.group))).map((group) => (
          <fieldset key={group} className={s.privilegeGroup}>
            <legend>{group}</legend>
            {catalog
              .filter((p) => p.group === group)
              .map((p) => (
                <div key={p.key}>
                  <Checkbox
                    label={p.label}
                    checked={selected.includes(p.key)}
                    onCheckedChange={(checked) => toggle(p.key, checked)}
                  />
                  <p className={s.muted}>{p.description}</p>
                </div>
              ))}
          </fieldset>
        ))}
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        <Button type="submit" loading={busy}>
          Rol opslaan
        </Button>
      </form>
    </Dialog>
  );
}
