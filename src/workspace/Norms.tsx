import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, BookOpen, Plus, Upload } from 'lucide-react';
import { Badge, Button, Checkbox, Dialog, Field } from '../components/ui';
import { api, can, json, uuid } from './api';
import type {
  NormDocument,
  NormExample,
  NormOutcome,
  NormRule,
  NormSummary,
  Organisation,
  RoomElement,
} from './api';
import { useResource } from './useResource';
import { ElementsModule } from './Elements';
import s from './workspace.module.css';

export const outcomeLabels: Record<NormOutcome, string> = {
  acceptable: 'Acceptabel',
  unacceptable: 'Niet acceptabel',
  not_assessable: 'Niet te beoordelen',
  not_applicable: 'Niet van toepassing',
};
export function NormsModule({
  base,
  scope,
  org,
}: {
  base: string;
  scope: string;
  org: Organisation;
}) {
  const location = useLocation(),
    params = new URLSearchParams(location.search),
    version = params.get('version'),
    benchmark = params.get('tab') === 'benchmark',
    elements = params.get('tab') === 'elements';
  const { data, error, reload } = useResource<NormSummary[]>(scope, `${base}/norms`),
    [create, setCreate] = useState(false);
  if (version) return <NormVersion base={base} scope={scope} org={org} id={version} />;
  return (
    <>
      <div className={s.pageHeading}>
        <div>
          <h1>Normen</h1>
          <p className={s.muted}>Kwaliteit per ruimte en object, met criteria en voorbeelden.</p>
        </div>
        {can(org, 'norms.manage') && !elements && (
          <Button icon={<Plus size={17} />} onClick={() => setCreate(true)}>
            Normenkader toevoegen
          </Button>
        )}
      </div>
      <nav className={s.stages} aria-label="Normenmodule">
        <Link className={!benchmark && !elements ? s.activeStage : ''} to="/app/norms">
          Normenkaders
        </Link>
        <Link className={elements ? s.activeStage : ''} to="/app/norms?tab=elements">
          Ruimtes en elementen
        </Link>
        {can(org, 'benchmarks.read') && (
          <Link className={benchmark ? s.activeStage : ''} to="/app/norms?tab=benchmark">
            Benchmark
          </Link>
        )}
      </nav>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      {elements ? (
        <ElementsModule base={base} scope={scope} org={org} />
      ) : benchmark ? (
        can(org, 'benchmarks.read') ? (
          <Benchmark
            base={base}
            scope={scope}
            versions={data?.filter((v) => v.status === 'published') || []}
          />
        ) : (
          <p>Je rol kan de benchmark niet bekijken.</p>
        )
      ) : (
        <div className={s.stack}>
          {data?.map((v) => (
            <Link key={v.id} to={`/app/norms?version=${v.id}`} className={s.normListRow}>
              <BookOpen size={22} />
              <div>
                <strong>{v.name}</strong>
                <p className={s.muted}>
                  Versie {v.number} · {v.ruleCount} maatregelen
                </p>
              </div>
              <Badge tone={v.status === 'published' ? 'success' : 'warning'}>
                {v.status === 'published' ? 'Gepubliceerd' : 'Concept'}
              </Badge>
            </Link>
          ))}
          {data && !data.length && (
            <section className={s.empty}>
              <BookOpen size={30} />
              <h2>Nog geen normenkaders</h2>
              <p>Een kwaliteitsbeheerder kan starten met het basiskader of eigen maatregelen.</p>
            </section>
          )}
        </div>
      )}
      {create && (
        <CreateNorm
          base={base}
          onClose={() => setCreate(false)}
          onCreated={() => {
            setCreate(false);
            reload();
          }}
        />
      )}
    </>
  );
}
function CreateNorm({
  base,
  onClose,
  onCreated,
}: {
  base: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('Basiskwaliteit woningen'),
    [baseline, setBaseline] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    navigate = useNavigate();
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title="Normenkader toevoegen"
      description="Een nieuw kader begint als concept en wordt pas na publicatie gebruikt."
      closeLabel="Sluiten"
    >
      <form
        className={s.stack}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const d = await api<NormDocument>(`${base}/norms`, json('POST', { name, baseline }));
            onCreated();
            navigate(`/app/norms?version=${d.id}`);
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field
          label="Naam normenkader"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Checkbox
          label="Start met basiskader (12 maatregelen en 24 voorbeelden)"
          checked={baseline}
          onCheckedChange={setBaseline}
        />
        <p className={s.muted}>
          Gebaseerd op openbare onderhoudsinformatie. Pas het concept aan aan het beleid van de
          corporatie.
        </p>
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        <Button type="submit" loading={busy}>
          Concept aanmaken
        </Button>
      </form>
    </Dialog>
  );
}
function NormVersion({
  base,
  scope,
  org,
  id,
}: {
  base: string;
  scope: string;
  org: Organisation;
  id: string;
}) {
  const { data, error, reload } = useResource<NormDocument>(scope, `${base}/norms/${id}`);
  if (!data)
    return (
      <>
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        <p role="status">Normenkader laden…</p>
      </>
    );
  return (
    <NormEditor
      key={id}
      initial={data}
      scope={scope}
      base={base}
      editable={can(org, 'norms.manage')}
      reload={reload}
    />
  );
}
function NormEditor({
  initial,
  base,
  scope,
  editable,
  reload,
}: {
  initial: NormDocument;
  base: string;
  scope: string;
  editable: boolean;
  reload: () => void;
}) {
  const [draft, setDraft] = useState(initial),
    [dirty, setDirty] = useState(false),
    [selected, setSelected] = useState(initial.rules[0]?.id || ''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    navigate = useNavigate();
  const { data: elements } = useResource<RoomElement[]>(scope, `${base}/elements`);
  const write = editable && draft.status === 'draft',
    rule = draft.rules.find((r) => r.id === selected);
  useEffect(() => {
    if (!dirty) setDraft(initial);
  }, [initial, dirty]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  function patch(value: Partial<NormDocument>) {
    setDraft((d) => ({ ...d, ...value }));
    setDirty(true);
    setNotice('');
  }
  function patchRule(value: Partial<NormRule>) {
    patch({ rules: draft.rules.map((r) => (r.id === selected ? { ...r, ...value } : r)) });
  }
  async function act(fn: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Opslaan mislukt');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className={s.back}
        onClick={() => {
          if (!dirty || window.confirm('Niet opgeslagen wijzigingen verlaten?'))
            navigate('/app/norms');
        }}
      >
        <ArrowLeft size={16} />
        Normenkaders
      </button>
      <div className={s.pageHeading}>
        <div>
          <h1>{draft.name}</h1>
          <p className={s.muted}>
            Versie {draft.number} ·{' '}
            {draft.status === 'published'
              ? 'Gepubliceerd · vastgelegd voor bestaande inspecties'
              : 'Concept'}
          </p>
        </div>
        <div className={s.actions}>
          {write && (
            <>
              <Button
                variant="secondary"
                loading={busy}
                disabled={!dirty}
                onClick={() =>
                  void act(async () => {
                    const res = await api<{ revision: number }>(
                      `${base}/norms/${draft.id}`,
                      json('PUT', {
                        name: draft.name,
                        description: draft.description,
                        rules: draft.rules,
                        revision: draft.revision,
                      }),
                    );
                    setDraft((d) => ({ ...d, revision: res.revision }));
                    setDirty(false);
                    setNotice('Concept opgeslagen');
                    reload();
                  })
                }
              >
                Concept opslaan
              </Button>
              <Button
                disabled={dirty || busy || !draft.rules.length}
                onClick={() => {
                  if (
                    window.confirm(
                      'Dit kader publiceren? De versie kan daarna niet meer gewijzigd worden.',
                    )
                  )
                    void act(async () => {
                      await api(
                        `${base}/norms/${draft.id}/publish`,
                        json('POST', { revision: draft.revision }),
                      );
                      reload();
                      setNotice('Normenkader gepubliceerd');
                    });
                }}
              >
                Publiceren
              </Button>
            </>
          )}
          {editable && draft.status === 'published' && (
            <Button
              onClick={() =>
                void act(async () => {
                  const next = await api<{ id: string }>(
                    `${base}/norms/${draft.id}/revisions`,
                    json('POST', {}),
                  );
                  navigate(`/app/norms?version=${next.id}`);
                })
              }
            >
              Nieuwe versie maken
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={s.success} role="status">
          {notice}
        </p>
      )}
      {dirty && <p className={s.warning}>Wijzigingen nog niet opgeslagen.</p>}
      {write && (
        <section className={s.panel}>
          <Field
            label="Naam kader"
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
          <label className={s.field}>
            <span>Omschrijving</span>
            <textarea
              aria-label="Omschrijving kader"
              value={draft.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </label>
        </section>
      )}
      <div className={s.normEditorGrid}>
        <aside className={s.normRuleNav}>
          <h2>Maatregelen ({draft.rules.length})</h2>
          {draft.rules.map((r) => (
            <button
              key={r.id}
              className={`${s.normRuleOption} ${r.id === selected ? s.selectedNorm : ''}`}
              onClick={() => setSelected(r.id)}
            >
              <strong>{r.code}</strong>
              <span>{r.title}</span>
              <small>{r.objectType}</small>
            </button>
          ))}
          {write && (
            <div className={s.normRuleAdd}>
              <Button
                variant="secondary"
                icon={<Plus size={16} />}
                onClick={() => {
                  const id = uuid();
                  patch({
                    rules: [
                      ...draft.rules,
                      {
                        id,
                        code: `MAAT-${draft.rules.length + 1}`,
                        title: 'Nieuwe maatregel',
                        rooms: ['*'],
                        objectType: 'Bouwdeel',
                        acceptable: '',
                        unacceptable: '',
                        aiGuidance: '',
                        modalities: ['photo', 'audio'],
                        priority: 'medium',
                        sourceUrls: [],
                        examples: [],
                      },
                    ],
                  });
                  setSelected(id);
                }}
              >
                Maatregel toevoegen
              </Button>
            </div>
          )}
        </aside>
        <section className={s.panel}>
          {rule ? (
            <>
              <div className={s.pageHeading}>
                <h2>{rule.title}</h2>
                {write && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (window.confirm('Deze maatregel uit het concept verwijderen?')) {
                        patch({ rules: draft.rules.filter((r) => r.id !== rule.id) });
                        setSelected(draft.rules.find((r) => r.id !== rule.id)?.id || '');
                      }
                    }}
                  >
                    Maatregel verwijderen
                  </Button>
                )}
              </div>
              {write ? (
                <>
                  <div className={s.twoColumns}>
                    <Field
                      label="Code"
                      maxLength={40}
                      value={rule.code}
                      onChange={(e) => patchRule({ code: e.target.value })}
                    />
                    <Field
                      label="Titel maatregel"
                      maxLength={160}
                      value={rule.title}
                      onChange={(e) => patchRule({ title: e.target.value })}
                    />
                  </div>
                  <Field
                    label="Ruimtes (komma's, * voor alle ruimtes)"
                    value={rule.rooms.join(', ')}
                    onChange={(e) =>
                      patchRule({ rooms: e.target.value.split(',').map((v) => v.trim()) })
                    }
                  />
                  <label className={s.field}>
                    <span>Element uit de ruimtedefinities</span>
                    <select
                      aria-label="Element uit de ruimtedefinities"
                      value={rule.elementId || ''}
                      onChange={(e) => {
                        const el = elements?.find((v) => v.id === e.target.value);
                        patchRule(
                          el
                            ? { elementId: el.id, objectType: el.name, rooms: el.rooms }
                            : { elementId: undefined },
                        );
                      }}
                    >
                      <option value="">Vrij object of bouwdeel</option>
                      {elements
                        ?.filter((e) => !e.archived || e.id === rule.elementId)
                        .map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                            {e.archived ? ' (gearchiveerd)' : ''}
                          </option>
                        ))}
                    </select>
                  </label>
                  <Field
                    label="Object of bouwdeel"
                    value={rule.objectType}
                    onChange={(e) => patchRule({ objectType: e.target.value })}
                  />
                </>
              ) : (
                <p className={s.muted}>
                  {rule.rooms.join(', ')} · {rule.objectType}
                </p>
              )}
              <RuleText
                title="Acceptabel"
                value={rule.acceptable}
                editable={write}
                onChange={(value) => patchRule({ acceptable: value })}
              />
              <RuleText
                title="Niet acceptabel"
                value={rule.unacceptable}
                editable={write}
                onChange={(value) => patchRule({ unacceptable: value })}
              />
              <RuleText
                title="Waar moet de AI op letten?"
                value={rule.aiGuidance}
                editable={write}
                onChange={(value) => patchRule({ aiGuidance: value })}
              />
              <div className={s.actions}>
                {write ? (
                  <>
                    <Checkbox
                      label="Foto's"
                      checked={rule.modalities.includes('photo')}
                      onCheckedChange={(v) =>
                        patchRule({
                          modalities: v
                            ? [...rule.modalities, 'photo']
                            : rule.modalities.filter((m) => m !== 'photo'),
                        })
                      }
                    />
                    <Checkbox
                      label="Audio via transcript"
                      checked={rule.modalities.includes('audio')}
                      onCheckedChange={(v) =>
                        patchRule({
                          modalities: v
                            ? [...rule.modalities, 'audio']
                            : rule.modalities.filter((m) => m !== 'audio'),
                        })
                      }
                    />
                    <label className={s.field}>
                      Prioriteit
                      <select
                        aria-label="Prioriteit"
                        value={rule.priority}
                        onChange={(e) =>
                          patchRule({ priority: e.target.value as NormRule['priority'] })
                        }
                      >
                        <option value="low">Laag</option>
                        <option value="medium">Normaal</option>
                        <option value="high">Hoog</option>
                      </select>
                    </label>
                  </>
                ) : (
                  <Badge>
                    {rule.modalities
                      .map((m) => (m === 'photo' ? 'Foto' : 'Transcript'))
                      .join(' + ')}{' '}
                    · {rule.priority}
                  </Badge>
                )}
              </div>
              <h3>Voorbeelden</h3>
              <p className={s.muted}>
                Leg zowel acceptabele als niet-acceptabele situaties vast. Foto's zijn
                referentiebeelden; audio gebruikt het ingevoerde voorbeeldtranscript.
              </p>
              {rule.examples.map((ex) => (
                <ExampleEditor
                  key={ex.id}
                  example={ex}
                  base={base}
                  editable={write}
                  onChange={(next) =>
                    patchRule({ examples: rule.examples.map((v) => (v.id === ex.id ? next : v)) })
                  }
                  onRemove={() =>
                    patchRule({ examples: rule.examples.filter((v) => v.id !== ex.id) })
                  }
                />
              ))}
              {write && rule.examples.length < 6 && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    patchRule({
                      examples: [
                        ...rule.examples,
                        { id: uuid(), outcome: 'acceptable', caption: '' },
                      ],
                    })
                  }
                >
                  Voorbeeld toevoegen
                </Button>
              )}
              {rule.sourceUrls.length > 0 && (
                <div className={s.stack}>
                  <h3>Bronnen bij deze maatregel</h3>
                  {rule.sourceUrls.map((url) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className={s.sourceLink}
                    >
                      {url}
                    </a>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p>Voeg een maatregel toe om het kwaliteitsniveau vast te leggen.</p>
          )}
        </section>
      </div>
      {!!draft.sources.length && (
        <section className={s.panel}>
          <h2>Basiskader: geraadpleegde bronnen</h2>
          <p className={s.muted}>
            Eigen conceptcriteria op basis van openbare informatie; geen NEN-conditiescore of
            juridisch oordeel. Broncontrole: {draft.sources[0].checkedAt}.
          </p>
          {draft.sources.map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className={s.sourceLink}
            >
              {source.title}
            </a>
          ))}
        </section>
      )}
    </>
  );
}
function RuleText({
  title,
  value,
  editable,
  onChange,
}: {
  title: string;
  value: string;
  editable: boolean;
  onChange: (v: string) => void;
}) {
  return editable ? (
    <label className={s.field}>
      <span>{title}</span>
      <textarea
        aria-label={title}
        rows={3}
        maxLength={3000}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  ) : (
    <div>
      <h3>{title}</h3>
      <p className={s.description}>{value}</p>
    </div>
  );
}
function ExampleEditor({
  example: ex,
  base,
  editable,
  onChange,
  onRemove,
}: {
  example: NormExample;
  base: string;
  editable: boolean;
  onChange: (v: NormExample) => void;
  onRemove: () => void;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  async function upload(file: File) {
    setBusy(true);
    setError('');
    try {
      const id = uuid();
      await api(`${base}/norm-assets/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) },
        body: file,
      });
      onChange({ ...ex, assetId: id });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={s.normExample}>
      {editable ? (
        <>
          <label className={s.field}>
            <span>Voorbeelduitkomst</span>
            <select
              aria-label="Voorbeelduitkomst"
              value={ex.outcome}
              onChange={(e) => onChange({ ...ex, outcome: e.target.value as NormOutcome })}
            >
              {Object.entries(outcomeLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className={s.field}>
            <span>Voorbeeldbeschrijving</span>
            <textarea
              aria-label="Voorbeeldbeschrijving"
              value={ex.caption}
              onChange={(e) => onChange({ ...ex, caption: e.target.value })}
            />
          </label>
          <label className={s.field}>
            <span>Voorbeeldtranscript (optioneel)</span>
            <textarea
              aria-label="Voorbeeldtranscript"
              value={ex.transcript || ''}
              onChange={(e) => onChange({ ...ex, transcript: e.target.value })}
            />
          </label>
          <div className={s.normUpload}>
            <div>
              <strong>Voorbeeldfoto of audio</strong>
              <p className={s.muted}>Foto tot 20 MB · audio tot 50 MB</p>
            </div>
            <Button
              type="button"
              variant="secondary"
              icon={<Upload size={16} />}
              loading={busy}
              onClick={() => fileInput.current?.click()}
            >
              {busy ? 'Uploaden…' : ex.assetId ? 'Bestand vervangen' : 'Bestand kiezen'}
            </Button>
            <input
              ref={fileInput}
              type="file"
              hidden
              aria-label="Voorbeeldfoto of audio toevoegen"
              disabled={busy}
              accept="image/jpeg,image/png,image/webp,audio/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
                e.target.value = '';
              }}
            />
          </div>
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Voorbeeld verwijderen
          </Button>
        </>
      ) : (
        <>
          <Badge
            tone={
              ex.outcome === 'acceptable'
                ? 'success'
                : ex.outcome === 'unacceptable'
                  ? 'danger'
                  : 'neutral'
            }
          >
            {outcomeLabels[ex.outcome]}
          </Badge>
          <p>{ex.caption}</p>
          {ex.transcript && <blockquote>{ex.transcript}</blockquote>}
        </>
      )}
      {ex.assetId && (
        <a
          className={s.sourceLink}
          target="_blank"
          rel="noreferrer"
          href={`/api/v1${base}/norm-assets/${ex.assetId}`}
        >
          Referentiebestand openen
        </a>
      )}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
type BenchmarkRow = {
  ruleId: string;
  room: string;
  acceptable: number;
  unacceptable: number;
  notAssessable: number;
  notApplicable: number;
  pending: number;
};
function Benchmark({
  base,
  scope,
  versions,
}: {
  base: string;
  scope: string;
  versions: NormSummary[];
}) {
  const [selected, setSelected] = useState('');
  const id = selected || versions[0]?.id;
  return (
    <section className={s.stack}>
      <p className={s.muted}>
        Vergelijk bevestigde beoordelingen binnen dezelfde normversie. Niet te beoordelen en niet
        van toepassing tellen niet als acceptabel. Aantallen zijn beoordelingen, geen aantallen
        woningen.
      </p>
      {id ? (
        <>
          <label className={s.field}>
            <span>Normversie voor benchmark</span>
            <select
              aria-label="Normversie voor benchmark"
              value={id}
              onChange={(e) => setSelected(e.target.value)}
            >
              {versions.map((v) => (
                <option value={v.id} key={v.id}>
                  {v.name} · versie {v.number}
                </option>
              ))}
            </select>
          </label>
          <BenchmarkResults key={id} base={base} scope={scope} id={id} />
        </>
      ) : (
        <p>Publiceer eerst een normenkader om beoordelingen te vergelijken.</p>
      )}
    </section>
  );
}
function BenchmarkResults({ base, scope, id }: { base: string; scope: string; id: string }) {
  const { data, error } = useResource<{ norms: NormDocument; rows: BenchmarkRow[] }>(
    scope,
    `${base}/norms/benchmark?normVersionId=${id}`,
  );
  const totals = (data?.rows || []).reduce(
    (v, r) => ({
      acceptable: v.acceptable + r.acceptable,
      unacceptable: v.unacceptable + r.unacceptable,
      unknown: v.unknown + r.notAssessable,
      na: v.na + r.notApplicable,
      pending: v.pending + r.pending,
    }),
    { acceptable: 0, unacceptable: 0, unknown: 0, na: 0, pending: 0 },
  );
  const assessed = totals.acceptable + totals.unacceptable;
  return (
    <>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      <div className={s.benchmarkStats}>
        {[
          [
            assessed ? `${Math.round((totals.acceptable / assessed) * 100)}%` : '—',
            'Acceptabel van beoordeelbaar',
          ],
          [totals.unacceptable, 'Niet acceptabel'],
          [totals.unknown, 'Niet te beoordelen'],
          [totals.pending, 'Nog te bevestigen'],
        ].map(([value, label]) => (
          <div key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className={s.normTableWrap}>
        <table className={s.normTable}>
          <caption>Beoordelingen per maatregel en ruimte · {data?.norms.name}</caption>
          <thead>
            <tr>
              <th>Maatregel / ruimte</th>
              <th>Acceptabel</th>
              <th>Niet acceptabel</th>
              <th>Niet te beoordelen</th>
              <th>N.v.t.</th>
              <th>Open</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((r) => (
              <tr key={`${r.ruleId}:${r.room}`}>
                <th>
                  {data.norms.rules.find((v) => v.id === r.ruleId)?.title}
                  <small>{r.room}</small>
                </th>
                <td>{r.acceptable}</td>
                <td>{r.unacceptable}</td>
                <td>{r.notAssessable}</td>
                <td>{r.notApplicable}</td>
                <td>{r.pending}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && !data.rows.length && (
        <p className={s.emptySmall}>Nog geen beoordelingen met deze normversie.</p>
      )}
    </>
  );
}
