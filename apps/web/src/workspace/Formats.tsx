import { useMobile } from './ResponsiveTabs';
import { protectedURL } from './platform';
import { FormatSelect, evidenceLabels, questionLabels } from './formatFields';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowUp, Check, Eye, FileText, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Checkbox, Dialog, Field } from '../components/ui';
import { api, can, json, uuid } from './api';
import type {
  FormatQuestion,
  FormatScope,
  InspectionFormat,
  NormDocument,
  NormSummary,
  Organisation,
  RoomElement,
} from './api';
import { useResource } from './useResource';
import s from './workspace.module.css';
import f from './formats.module.css';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const newQuestion = (): FormatQuestion => ({
  id: uuid(),
  title: '',
  kind: 'text',
  required: true,
  instruction: '',
  talkingPrompt: '',
  ruleId: '',
  elementId: '',
  choices: [],
  unit: '',
  evidence: 'photo',
  minPhotos: 1,
});
export function FormatsModule({
  base,
  scope,
  org,
}: {
  base: string;
  scope: string;
  org: Organisation;
}) {
  const mobile = useMobile();
  const { data, error } = useResource<InspectionFormat[]>(scope, `${base}/formats`),
    location = useLocation(),
    navigate = useNavigate();
  const version = new URLSearchParams(location.search).get('version');
  const [create, setCreate] = useState(false),
    [name, setName] = useState('Voorinspectie'),
    [kind, setKind] = useState('pre'),
    [norm, setNorm] = useState(''),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState('');
  const { data: norms } = useResource<NormSummary[]>(scope, `${base}/norms`);
  if (version)
    return <FormatEditor key={version} base={base} scope={scope} org={org} version={version} />;
  return (
    <>
      <div className={s.pageHeading}>
        <div>
          <h1>Inspectiesjablonen</h1>
          <p className={s.muted}>Vragen, bewijs en spreekhulp per ruimte.</p>
        </div>
        {!mobile && can(org, 'formats.manage') && (
          <Button icon={<Plus size={17} />} onClick={() => setCreate(true)}>
            Inspectiesjabloon toevoegen
          </Button>
        )}
      </div>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      <div className={s.stack}>
        {!data?.length && (
          <section className={s.empty}>
            <FileText size={32} />
            <h2>Nog geen inspectiesjablonen</h2>
            <p>
              Maak een concept, koppel beoordelingscriteria en publiceer het voordat inspecteurs
              beginnen.
            </p>
          </section>
        )}
        {data?.map((d) => (
          <Link className={s.normListRow} key={d.id} to={`/app/formats?version=${d.id}`}>
            <FileText size={22} />
            <div>
              <strong>{d.name}</strong>
              <p className={s.muted}>
                {d.kind === 'pre' ? 'Voorinspectie' : 'Eindinspectie'} · versie {d.number} ·{' '}
                {d.scopes.reduce((n, c) => n + c.questions.length, 0)} vragen
              </p>
            </div>
            <Badge tone={d.status === 'published' ? 'success' : 'neutral'}>
              {d.status === 'published' ? 'Gepubliceerd' : 'Concept'}
            </Badge>
          </Link>
        ))}
      </div>
      <Dialog
        open={create}
        onOpenChange={setCreate}
        title="Inspectiesjabloon toevoegen"
        description="Begin met een bewerkbaar concept met gangbare ruimtes."
      >
        <form
          className={s.stack}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setFailure('');
            try {
              const result = await api<{ id: string }>(
                `${base}/formats`,
                json('POST', { name, kind, normVersionId: norm || null }),
              );
              setCreate(false);
              navigate(`/app/formats?version=${result.id}`);
            } catch (e) {
              setFailure(message(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field
            label="Naam"
            required
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <FormatSelect
            label="Inspectietype"
            value={kind}
            onChange={(v) => {
              setKind(v);
              setName(v === 'pre' ? 'Voorinspectie' : 'Eindinspectie');
            }}
          >
            <option value="pre">Voorinspectie</option>
            <option value="final">Eindinspectie</option>
          </FormatSelect>
          <FormatSelect label="Kwaliteitskader" value={norm} onChange={setNorm}>
            <option value="">Later koppelen</option>
            {norms
              ?.filter((n) => n.status === 'published')
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name} · versie {n.number}
                </option>
              ))}
          </FormatSelect>
          {failure && (
            <p className={s.error} role="alert">
              {failure}
            </p>
          )}
          <Button type="submit" loading={busy}>
            Concept aanmaken
          </Button>
        </form>
      </Dialog>
    </>
  );
}
function FormatEditor({
  base,
  scope,
  org,
  version,
}: {
  base: string;
  scope: string;
  org: Organisation;
  version: string;
}) {
  const mobile = useMobile();
  const { data, error, reload } = useResource<InspectionFormat>(
      scope,
      `${base}/formats/${version}`,
    ),
    { data: norms } = useResource<NormSummary[]>(scope, `${base}/norms`),
    { data: elements } = useResource<RoomElement[]>(scope, `${base}/elements`);
  const [draft, setDraft] = useState<InspectionFormat>(),
    [dirty, setDirty] = useState(false),
    [selected, setSelected] = useState(''),
    [failure, setFailure] = useState(''),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState(false),
    [notice, setNotice] = useState(''),
    [norm, setNorm] = useState<NormDocument>();
  const navigate = useNavigate();
  useEffect(() => {
    if (data && !dirty) {
      setDraft(data);
      setSelected((v) => v || data.scopes[0]?.id || '');
    }
  }, [data, dirty]);
  useEffect(() => {
    setNorm(undefined);
    if (draft?.normVersionId)
      void api<NormDocument>(`${base}/norms/${draft.normVersionId}`)
        .then(setNorm)
        .catch((e) => setFailure(message(e)));
  }, [base, draft?.normVersionId]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  if (!draft) return <p role={error ? 'alert' : 'status'}>{error || 'Inspectiesjabloon laden…'}</p>;
  const editable = !mobile && draft.status === 'draft' && can(org, 'formats.manage'),
    category = draft.scopes.find((c) => c.id === selected) || draft.scopes[0];
  function patch(v: Partial<InspectionFormat>) {
    setDraft((d) => (d ? { ...d, ...v } : d));
    setDirty(true);
    setNotice('');
  }
  function patchScope(v: Partial<FormatScope>) {
    patch({ scopes: draft!.scopes.map((c) => (c.id === category.id ? { ...c, ...v } : c)) });
  }
  function patchQuestion(qid: string, v: Partial<FormatQuestion>) {
    patchScope({ questions: category.questions.map((q) => (q.id === qid ? { ...q, ...v } : q)) });
  }
  async function save() {
    const payload = {
      ...draft!,
      scopes: draft!.scopes.map((category) => ({
        ...category,
        questions: category.questions.map((question) => ({
          ...question,
          choices: question.choices.map((choice) => choice.trim()),
          condition: question.condition
            ? { ...question.condition, equals: question.condition.equals.trim() }
            : undefined,
        })),
      })),
    };
    const result = await api<{ revision: number }>(
      `${base}/formats/${version}`,
      json('PUT', payload),
    );
    const current = { ...payload, revision: result.revision };
    setDraft(current);
    setDirty(false);
    return current;
  }
  async function action(publish: boolean) {
    setBusy(true);
    setFailure('');
    try {
      const current = dirty ? await save() : draft!;
      if (publish) {
        await api(
          `${base}/formats/${version}/publish`,
          json('POST', { revision: current.revision }),
        );
        await reload();
        setNotice('Inspectiesjabloon gepubliceerd');
      } else setNotice('Concept bewaard');
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link
        className={s.back}
        to="/app/formats"
        onClick={(e) => {
          if (dirty && !window.confirm('Niet-opgeslagen formatwijzigingen verlaten?'))
            e.preventDefault();
        }}
      >
        <ArrowLeft size={16} />
        Inspectiesjablonen
      </Link>
      <div className={s.pageHeading}>
        <div>
          <h1>{draft.name}</h1>
          <p className={s.muted}>
            Versie {draft.number} · {draft.status === 'draft' ? 'Concept' : 'Gepubliceerd'}
          </p>
        </div>
        <div className={s.actions}>
          <Button variant="secondary" icon={<Eye size={16} />} onClick={() => setPreview(!preview)}>
            {preview ? 'Bewerken' : 'Voorbeeld'}
          </Button>
          {editable ? (
            <>
              <Button
                variant="secondary"
                loading={busy}
                disabled={!dirty}
                onClick={() => void action(false)}
              >
                Concept bewaren
              </Button>
              <Button loading={busy} icon={<Check size={16} />} onClick={() => void action(true)}>
                Publiceren
              </Button>
            </>
          ) : (
            !mobile &&
            can(org, 'formats.manage') && (
              <Button
                onClick={async () => {
                  try {
                    const d = await api<{ id: string }>(
                      `${base}/formats/${version}/revisions`,
                      json('POST', {}),
                    );
                    navigate(`/app/formats?version=${d.id}`);
                  } catch (e) {
                    setFailure(message(e));
                  }
                }}
              >
                Nieuwe versie
              </Button>
            )
          )}
        </div>
      </div>
      {failure && (
        <p className={s.error} role="alert">
          {failure}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {preview ? (
        <FormatPreview format={draft} />
      ) : (
        <>
          <fieldset disabled={!editable || busy} className={f.settings}>
            <div className={s.twoColumns}>
              <Field
                label="Naam inspectiesjabloon"
                value={draft.name}
                maxLength={160}
                onChange={(e) => patch({ name: e.target.value })}
              />
              <FormatSelect
                label="Inspectietype"
                value={draft.kind}
                onChange={(v) => patch({ kind: v as InspectionFormat['kind'] })}
              >
                <option value="pre">Voorinspectie</option>
                <option value="final">Eindinspectie</option>
              </FormatSelect>
            </div>
            <Field
              label="Beschrijving"
              maxLength={3000}
              value={draft.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
            <Field
              label="Ondertekenverklaring"
              value={draft.acknowledgement || ''}
              maxLength={4000}
              onChange={(e) => patch({ acknowledgement: e.target.value })}
            />
            <p>
              {draft.signingPolicy === 'legacy'
                ? 'Bestaand sjabloon: ondertekening optioneel. Een nieuwe versie gebruikt het nieuwe ondertekenbeleid.'
                : 'Inspecteur ondertekent; bewoner ondertekent of krijgt een vastgelegde uitzondering.'}
            </p>
            <FormatSelect
              label="Gepubliceerd kwaliteitskader"
              value={draft.normVersionId || ''}
              onChange={(v) => {
                if (
                  draft.scopes.some((s) => s.questions.some((q) => q.ruleId)) &&
                  !window.confirm(
                    'Ander kwaliteitskader kiezen? Bestaande criteriumkoppelingen worden gewist.',
                  )
                )
                  return;
                patch({
                  normVersionId: v || null,
                  scopes: draft.scopes.map((s) => ({
                    ...s,
                    questions: s.questions.map((q) => ({
                      ...q,
                      ruleId: '',
                      kind: q.kind === 'quality' ? 'text' : q.kind,
                    })),
                  })),
                });
              }}
            >
              <option value="">Kies een kwaliteitskader</option>
              {norms
                ?.filter((n) => n.status === 'published')
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name} · versie {n.number}
                  </option>
                ))}
            </FormatSelect>
          </fieldset>
          <div className={f.builder}>
            <aside className={f.categories}>
              <h2>Ruimtes</h2>
              {draft.scopes.map((c) => (
                <button
                  key={c.id}
                  className={c.id === category.id ? f.selected : ''}
                  onClick={() => setSelected(c.id)}
                >
                  <span>{c.name}</span>
                  <small>{c.questions.length}</small>
                </button>
              ))}
              {editable && (
                <Button
                  variant="ghost"
                  icon={<Plus size={15} />}
                  onClick={() => {
                    const c: FormatScope = {
                      id: uuid(),
                      name: 'Nieuwe ruimte',
                      normRoom: '',
                      property: false,
                      required: false,
                      repeatable: false,
                      questions: [],
                    };
                    patch({ scopes: [...draft.scopes, c] });
                    setSelected(c.id);
                  }}
                >
                  Ruimte toevoegen
                </Button>
              )}
            </aside>
            <section className={f.questions}>
              <fieldset disabled={!editable || busy} className={f.settings}>
                <div className={s.twoColumns}>
                  <Field
                    label="Ruimtenaam"
                    maxLength={100}
                    value={category.name}
                    onChange={(e) => patchScope({ name: e.target.value })}
                  />
                  {!category.property && (
                    <Field
                      label="Ruimtetype in kwaliteitskader"
                      maxLength={100}
                      list="norm-room-types"
                      value={category.normRoom}
                      onChange={(e) => patchScope({ normRoom: e.target.value })}
                    />
                  )}
                </div>
                <datalist id="norm-room-types">
                  {Array.from(new Set(norm?.rules.flatMap((r) => r.rooms) || []))
                    .filter((v) => v !== '*')
                    .map((v) => (
                      <option key={v} value={v} />
                    ))}
                </datalist>
                {!category.property && (
                  <div className={s.actions}>
                    <Checkbox
                      label="Verplicht aanwezig of afmelden"
                      checked={category.required}
                      onCheckedChange={(v) => patchScope({ required: v })}
                    />
                    <p className={s.muted}>
                      Inspecteurs kunnen extra ruimtes van dit type toevoegen.
                    </p>
                  </div>
                )}
                {category.questions.map((q, index) => (
                  <article key={q.id} className={f.question}>
                    <div className={f.questionHeader}>
                      <strong>Vraag {index + 1}</strong>
                      <div className={s.actions}>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Vraag omhoog"
                          disabled={index === 0}
                          onClick={() => {
                            const questions = [...category.questions];
                            [questions[index - 1], questions[index]] = [
                              questions[index],
                              questions[index - 1],
                            ];
                            patchScope({ questions });
                          }}
                        >
                          <ArrowUp size={15} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Vraag omlaag"
                          disabled={index === category.questions.length - 1}
                          onClick={() => {
                            const questions = [...category.questions];
                            [questions[index + 1], questions[index]] = [
                              questions[index],
                              questions[index + 1],
                            ];
                            patchScope({ questions });
                          }}
                        >
                          <ArrowDown size={15} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Vraag verwijderen"
                          onClick={() => {
                            if (window.confirm('Deze vraag verwijderen?'))
                              patchScope({
                                questions: category.questions
                                  .filter((v) => v.id !== q.id)
                                  .map((v) =>
                                    v.condition?.questionId === q.id
                                      ? { ...v, condition: undefined }
                                      : v,
                                  ),
                              });
                          }}
                        >
                          <Trash2 size={15} />
                        </Button>
                      </div>
                    </div>
                    <Field
                      label="Vraag"
                      maxLength={240}
                      value={q.title}
                      onChange={(e) => patchQuestion(q.id, { title: e.target.value })}
                    />
                    <div className={s.twoColumns}>
                      <FormatSelect
                        label="Antwoordtype"
                        value={q.kind}
                        onChange={(v) =>
                          patchQuestion(q.id, {
                            kind: v as FormatQuestion['kind'],
                            choices:
                              v === 'choice'
                                ? q.choices.length
                                  ? q.choices
                                  : ['Ja', 'Nee']
                                : q.choices,
                          })
                        }
                      >
                        {Object.entries(questionLabels).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </FormatSelect>
                      <FormatSelect
                        label="Benodigde onderbouwing"
                        value={q.evidence}
                        onChange={(v) =>
                          patchQuestion(q.id, { evidence: v as FormatQuestion['evidence'] })
                        }
                      >
                        {Object.entries(evidenceLabels).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </FormatSelect>
                    </div>
                    <Checkbox
                      label="Verplicht voor afronding"
                      checked={q.required}
                      onCheckedChange={(v) => patchQuestion(q.id, { required: v })}
                    />
                    {(q.evidence === 'photo' || q.evidence === 'photo_statement') && (
                      <Field
                        label="Minimum aantal foto's"
                        type="number"
                        min={1}
                        max={20}
                        value={q.minPhotos || 1}
                        onChange={(e) => patchQuestion(q.id, { minPhotos: Number(e.target.value) })}
                      />
                    )}
                    {q.kind === 'choice' && (
                      <Field
                        label="Antwoordopties (gescheiden met puntkomma)"
                        value={q.choices.join(';')}
                        onChange={(e) =>
                          patchQuestion(q.id, {
                            choices: e.target.value.split(';'),
                          })
                        }
                      />
                    )}
                    {q.kind === 'number' && (
                      <Field
                        label="Eenheid"
                        maxLength={40}
                        value={q.unit}
                        onChange={(e) => patchQuestion(q.id, { unit: e.target.value })}
                      />
                    )}
                    <FormatSelect
                      label="Gekoppeld criterium"
                      value={q.ruleId}
                      onChange={(v) => {
                        const rule = norm?.rules.find((r) => r.id === v);
                        patchQuestion(q.id, {
                          ruleId: v,
                          elementId: rule?.elementId || q.elementId,
                          ...(q.kind === 'quality' && rule ? { title: q.title || rule.title } : {}),
                        });
                      }}
                    >
                      <option value="">Geen criteriumkoppeling</option>
                      {norm?.rules
                        .filter(
                          (r) =>
                            category.property ||
                            r.rooms.some(
                              (n) =>
                                n === '*' ||
                                n.toLowerCase() === category.normRoom.trim().toLowerCase(),
                            ),
                        )
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.code} · {r.title}
                          </option>
                        ))}
                    </FormatSelect>
                    {q.ruleId && (
                      <details className={f.reference}>
                        <summary>Criteria en voorbeelden bekijken</summary>
                        <p>
                          <strong>Acceptabel:</strong>{' '}
                          {norm?.rules.find((r) => r.id === q.ruleId)?.acceptable}
                        </p>
                        <p>
                          <strong>Niet acceptabel:</strong>{' '}
                          {norm?.rules.find((r) => r.id === q.ruleId)?.unacceptable}
                        </p>
                        {norm?.rules
                          .find((r) => r.id === q.ruleId)
                          ?.examples.map((ex) => (
                            <figure key={ex.id}>
                              {ex.assetId && (
                                <img
                                  alt={ex.caption}
                                  src={protectedURL(`/api/v1${base}/norm-assets/${ex.assetId}`)}
                                />
                              )}
                              <figcaption>{ex.caption}</figcaption>
                            </figure>
                          ))}
                      </details>
                    )}
                    <FormatSelect
                      label="Ruimte-element"
                      value={q.elementId}
                      onChange={(v) => patchQuestion(q.id, { elementId: v })}
                    >
                      <option value="">Geen element</option>
                      {elements
                        ?.filter((el) => !el.archived)
                        .map((el) => (
                          <option key={el.id} value={el.id}>
                            {el.name}
                          </option>
                        ))}
                    </FormatSelect>
                    <Field
                      label="Instructie voor onderbouwing en AI"
                      maxLength={3000}
                      value={q.instruction}
                      onChange={(e) => patchQuestion(q.id, { instruction: e.target.value })}
                    />
                    <Field
                      label="Spreekhulp voor inspecteur"
                      placeholder={
                        q.title
                          ? `Beschrijf: ${q.title.toLowerCase()}`
                          : 'Wat moet de inspecteur bespreken?'
                      }
                      maxLength={500}
                      value={q.talkingPrompt}
                      onChange={(e) => patchQuestion(q.id, { talkingPrompt: e.target.value })}
                    />
                    <FormatSelect
                      label="Wanneer stellen?"
                      value={q.condition?.questionId || ''}
                      onChange={(v) => {
                        const parent = category.questions.find((p) => p.id === v);
                        patchQuestion(q.id, {
                          condition: v
                            ? {
                                questionId: v,
                                equals:
                                  parent?.kind === 'boolean' ? 'true' : parent?.choices[0] || '',
                              }
                            : undefined,
                        });
                      }}
                    >
                      <option value="">Altijd in deze ruimte</option>
                      {category.questions
                        .slice(0, index)
                        .filter((p) => p.required && (p.kind === 'boolean' || p.kind === 'choice'))
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            Na: {p.title}
                          </option>
                        ))}
                    </FormatSelect>
                    {q.condition && (
                      <FormatSelect
                        label="Alleen bij antwoord"
                        value={q.condition.equals}
                        onChange={(v) =>
                          patchQuestion(q.id, { condition: { ...q.condition!, equals: v } })
                        }
                      >
                        {(category.questions.find((p) => p.id === q.condition?.questionId)?.kind ===
                        'boolean'
                          ? ['true', 'false']
                          : category.questions.find((p) => p.id === q.condition?.questionId)
                              ?.choices || []
                        ).map((v) => (
                          <option key={v} value={v}>
                            {v === 'true' ? 'Ja' : v === 'false' ? 'Nee' : v}
                          </option>
                        ))}
                      </FormatSelect>
                    )}
                  </article>
                ))}
                {editable && (
                  <Button
                    variant="secondary"
                    icon={<Plus size={17} />}
                    onClick={() =>
                      patchScope({ questions: [...category.questions, newQuestion()] })
                    }
                  >
                    Vraag toevoegen
                  </Button>
                )}
                {editable && !category.property && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (window.confirm('Deze ruimtecategorie met vragen verwijderen?')) {
                        patch({ scopes: draft.scopes.filter((c) => c.id !== category.id) });
                        setSelected(draft.scopes.find((c) => c.id !== category.id)?.id || '');
                      }
                    }}
                  >
                    Ruimtecategorie verwijderen
                  </Button>
                )}
              </fieldset>
            </section>
          </div>
        </>
      )}
    </>
  );
}
function FormatPreview({ format }: { format: InspectionFormat }) {
  return (
    <div className={s.stack}>
      {format.scopes.map((c) => (
        <section key={c.id} className={f.preview}>
          <h2>{c.name}</h2>
          <p className={s.muted}>
            {c.property
              ? 'Woningbreed'
              : c.required
                ? 'Verplicht of expliciet afmelden'
                : 'Optioneel toe te voegen'}
            {!c.property ? ' · meerdere ruimtes mogelijk' : ''}
          </p>
          <h3>Bespreek deze punten</h3>
          <ul>
            {c.questions.slice(0, 3).map((q) => (
              <li key={q.id}>
                {q.talkingPrompt || q.instruction || `Beschrijf: ${q.title.toLowerCase()}`}
              </li>
            ))}
          </ul>
          <details>
            <summary>Alle vragen en vereiste onderbouwing ({c.questions.length})</summary>
            {c.questions.map((q) => (
              <p key={q.id}>
                <strong>{q.title}</strong> · {questionLabels[q.kind]} · {evidenceLabels[q.evidence]}
                {q.required ? ' · verplicht' : ''}
                {q.condition ? ' · voorwaardelijk' : ''}
              </p>
            ))}
          </details>
        </section>
      ))}
    </div>
  );
}
