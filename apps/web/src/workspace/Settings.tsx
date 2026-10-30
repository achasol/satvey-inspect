import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, Plus } from 'lucide-react';
import { Button, Dialog, Field } from '../components/ui';
import { api, can, json } from './api';
import type { Organisation } from './api';
import { RoleSettings } from './RoleSettings';
import { PropertySettings } from './PropertySettings';
import { Invitations } from './Invitations';
import type { OrgRole, RolesData } from './RoleSettings';
import s from './workspace.module.css';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function SettingsView({
  base,
  org,
  scope,
}: {
  base: string;
  org: Organisation;
  scope: string;
}) {
  const location = useLocation(),
    manage = can(org, 'settings.manage');
  const tabs = [
    { id: 'account', label: 'Account' },
    ...(manage
      ? [
          { id: 'members', label: 'Leden en uitnodigingen' },
          { id: 'roles', label: 'Rollen en privileges' },
          { id: 'sso', label: 'SSO' },
          { id: 'properties', label: 'Vastgoedkoppeling' },
        ]
      : []),
  ];
  const requested = new URLSearchParams(location.search).get('tab') || 'account',
    tab = tabs.some((t) => t.id === requested) ? requested : 'account';
  const [email, setEmail] = useState(''),
    [role, setRole] = useState(''),
    [invitation, setInvitation] = useState(''),
    [inviteOpen, setInviteOpen] = useState(false),
    [issuer, setIssuer] = useState(''),
    [clientId, setClientId] = useState(''),
    [clientSecret, setClientSecret] = useState(''),
    [domains, setDomains] = useState(''),
    [current, setCurrent] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [roleChoices, setRoleChoices] = useState<OrgRole[]>([]);
  const loadedSSO = useRef('');
  useEffect(() => {
    setError('');
    setNotice('');
  }, [tab]);
  useEffect(() => {
    if (!manage || tab !== 'sso' || loadedSSO.current === base) return;
    let alive = true;
    void api<{ issuer: string; clientId: string; domains: string[] }>(`${base}/sso`)
      .then((value) => {
        if (alive) {
          setIssuer(value.issuer);
          setClientId(value.clientId);
          setDomains(value.domains.join(', '));
          loadedSSO.current = base;
        }
      })
      .catch((e) => {
        if (alive) setError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [base, manage, tab]);
  useEffect(() => {
    if (!manage || tab !== 'members') return;
    let alive = true;
    const load = () =>
      void api<RolesData>(`${base}/roles`)
        .then((data) => {
          if (alive) {
            setRoleChoices(data.roles);
            setRole((current) =>
              data.roles.some((r) => r.id === current)
                ? current
                : data.roles.find((r) => r.systemKey === 'inspector')?.id ||
                  data.roles[0]?.id ||
                  '',
            );
          }
        })
        .catch((e) => {
          if (alive) setError(message(e));
        });
    load();
    window.addEventListener('satvey-refresh', load);
    return () => {
      alive = false;
      window.removeEventListener('satvey-refresh', load);
    };
  }, [base, manage, tab]);
  async function act(fn: () => Promise<void>) {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className={s.pageHeading}>
        <h1>Instellingen</h1>
      </div>
      <nav className={s.stages} aria-label="Instellingenonderdelen">
        {tabs.map((item) => (
          <Link
            key={item.id}
            to={item.id === 'account' ? '/app/settings' : `/app/settings?tab=${item.id}`}
            className={tab === item.id ? s.activeStage : ''}
            aria-current={tab === item.id ? 'page' : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={s.success}>
          {notice}
        </p>
      )}
      <div className={s.settingsContent}>
        {manage && (
          <div hidden={tab !== 'properties'}>
            <PropertySettings key={base} base={base} scope={scope} />
          </div>
        )}
        {tab === 'account' && (
          <section className={s.stack} aria-label="Je account">
            <h2>Je account</h2>
            <a href={`/api/v1/auth/oidc/start?org=${org.slug}&link=true`} className={s.nextLink}>
              SSO aan dit account koppelen <ArrowRight size={16} />
            </a>
            <details>
              <summary>Wachtwoord wijzigen</summary>
              <form
                className={s.settingsForm}
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    await api('/auth/password', json('POST', { current, password }));
                    setCurrent('');
                    setPassword('');
                    setNotice('Wachtwoord gewijzigd. Andere sessies zijn uitgelogd.');
                  });
                }}
              >
                <Field
                  label="Huidig wachtwoord"
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                />
                <Field
                  label="Nieuw wachtwoord"
                  type="password"
                  minLength={12}
                  required
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Button type="submit" variant="secondary" loading={busy}>
                  Wachtwoord wijzigen
                </Button>
              </form>
            </details>
          </section>
        )}
        {tab === 'members' && manage && (
          <>
            <div className={s.pageHeading}>
              <h2>Organisatieleden</h2>
              <Button icon={<Plus size={16} />} onClick={() => setInviteOpen(true)}>
                Lid uitnodigen
              </Button>
            </div>
            <Members base={base} roles={roleChoices} />
            <Invitations base={base} scope={scope} />
          </>
        )}
        {tab === 'roles' && manage && <RoleSettings base={base} scope={scope} />}
        {tab === 'sso' && manage && (
          <section className={s.stack} aria-label="Organisatie-SSO">
            <h2>Organisatie-SSO</h2>
            <p className={s.muted}>Callback: {window.location.origin}/api/v1/auth/oidc/callback</p>
            <form
              className={s.settingsForm}
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await api(
                    `${base}/sso`,
                    json('PUT', {
                      issuer,
                      clientId,
                      clientSecret,
                      domains: domains
                        .split(',')
                        .map((d) => d.trim())
                        .filter(Boolean),
                    }),
                  );
                  setClientSecret('');
                  setNotice('SSO-instellingen opgeslagen.');
                });
              }}
            >
              <Field
                label="OIDC issuer URL"
                type="url"
                required
                value={issuer}
                onChange={(e) => setIssuer(e.target.value)}
              />
              <Field
                label="E-maildomeinen voor SSO"
                placeholder="organisatie.nl, organisatie.com"
                value={domains}
                onChange={(e) => setDomains(e.target.value)}
              />
              <Field
                label="Client-ID"
                required
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
              <Field
                label="Client secret (optioneel)"
                type="password"
                autoComplete="off"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
              <Button variant="secondary" type="submit" loading={busy}>
                SSO opslaan
              </Button>
            </form>
          </section>
        )}
      </div>
      <Dialog
        open={inviteOpen && manage && tab === 'members'}
        onOpenChange={setInviteOpen}
        title="Lid uitnodigen"
        description="Kies het e-mailadres en de rol."
      >
        <form
          className={s.stack}
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const result = await api<{ url: string; delivery: string }>(
                `${base}/invitations`,
                json('POST', { email, roleId: role }),
              );
              setInvitation(result.url);
              setNotice(
                result.delivery === 'manual'
                  ? 'Deel de uitnodigingslink met de gebruiker.'
                  : 'Uitnodiging staat klaar voor verzending per e-mail.',
              );
              window.dispatchEvent(new Event('satvey-refresh'));
            });
          }}
        >
          <Field
            label="E-mailadres"
            type="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setInvitation('');
            }}
          />
          <label className={s.field}>
            <span>Rol</span>
            <select
              aria-label="Rol"
              value={role}
              onChange={(e) => {
                setRole(e.target.value);
                setInvitation('');
              }}
            >
              {roleChoices.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" loading={busy} disabled={!role}>
            Uitnodigingslink maken
          </Button>
          {invitation && (
            <>
              <p className={s.muted}>
                Deel deze link met de uitgenodigde gebruiker. Geldig voor 7 dagen.
              </p>
              <input
                aria-label="Uitnodigingslink"
                className={s.invitationURL}
                readOnly
                value={invitation}
                onFocus={(e) => e.target.select()}
              />
            </>
          )}
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
        </form>
      </Dialog>
    </>
  );
}

function Members({ base, roles }: { base: string; roles: OrgRole[] }) {
  const [members, setMembers] = useState<
      { id: string; email: string; name: string; roleId: string }[]
    >([]),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void api<typeof members>(`${base}/members`)
      .then((data) => {
        if (alive) setMembers(data);
      })
      .catch((e) => {
        if (alive) setError(message(e));
      });
    return () => {
      alive = false;
    };
  }, [base]);
  async function update(id: string, role: string) {
    setError('');
    try {
      await api(
        `${base}/members/${id}`,
        json('PUT', role === 'remove' ? { role } : { roleId: role }),
      );
      setMembers(await api<typeof members>(`${base}/members`));
      window.dispatchEvent(new Event('satvey-auth-changed'));
    } catch (e) {
      setError(message(e));
    }
  }
  return (
    <section className={s.stack} aria-label="Organisatieleden">
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      {members.map((member) => (
        <div className={s.member} key={member.id}>
          <strong>{member.name}</strong>
          <span>{member.email}</span>
          <label className={s.field}>
            <span>Rol van {member.name}</span>
            <select
              aria-label={`Rol van ${member.name}`}
              value={member.roleId}
              onChange={(e) => {
                const role = e.target.value;
                if (
                  role !== 'remove' ||
                  window.confirm(`${member.name} uit deze organisatie verwijderen?`)
                )
                  void update(member.id, role);
              }}
            >
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
              <option value="remove">Verwijderen</option>
            </select>
          </label>
        </div>
      ))}
    </section>
  );
}
