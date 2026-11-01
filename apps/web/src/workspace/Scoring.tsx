import { useState } from 'react';
import { Button, Checkbox, Field } from '../components/ui';
import { api, uuid, type NormRule, type ScoreDetail, type ScoreLevel } from './api';
import { loadProtectedResource, protectedURL } from './platform';
import { Select, ErrorNotice, errorText } from './shared';
import s from './workspace.module.css';

const responsibility = {
  undetermined: 'Nog te bepalen',
  corporation: 'Corporatie',
  resident: 'Bewoner',
};
const fresh = (): ScoreLevel[] =>
  ['Uitstekend', 'Goed', 'Redelijk', 'Matig', 'Slecht', 'Zeer slecht'].map((label, index) => ({
    score: index + 1,
    label,
    description: '',
    outcome: '',
    repairResponsibility: 'undetermined',
    costResponsibility: 'undetermined',
    references: [],
  }));
export function ScoreLevelsEditor({
  rule,
  base,
  editable,
  onChange,
}: {
  rule: NormRule;
  base: string;
  editable: boolean;
  onChange: (levels: ScoreLevel[]) => void;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const levels = rule.scoreLevels || [];
  const patch = (score: number, update: Partial<ScoreLevel>) =>
    onChange(levels.map((level) => (level.score === score ? { ...level, ...update } : level)));
  return (
    <section className={s.stack}>
      <h3>Scores en verantwoordelijkheid</h3>
      <p className={s.muted}>
        Eigen schaal: 1 is de beste, 6 de slechtste staat. Uitkomst, herstel en kosten worden per
        criterium vastgelegd.
      </p>
      {editable && (
        <Checkbox
          label="Scoreschaal 1–6 gebruiken"
          checked={!!levels.length}
          onCheckedChange={(enabled) => onChange(enabled ? fresh() : [])}
        />
      )}
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {levels.map((level) => (
        <fieldset
          className={`${s.scoreLevel} ${s.stack}`}
          key={level.score}
          disabled={!editable || busy}
        >
          <legend>
            Score {level.score} · {level.label}
          </legend>
          <Field
            label={`Naam score ${level.score}`}
            value={level.label}
            maxLength={100}
            onChange={(e) => patch(level.score, { label: e.target.value })}
          />
          <Field
            label={`Omschrijving score ${level.score}`}
            value={level.description}
            maxLength={3000}
            onChange={(e) => patch(level.score, { description: e.target.value })}
          />
          <div className={s.elementFilters}>
            <Select
              label={`Uitkomst score ${level.score}`}
              value={level.outcome}
              onChange={(outcome) =>
                patch(level.score, { outcome: outcome as ScoreLevel['outcome'] })
              }
            >
              <option value="">Kies het beleid</option>
              <option value="acceptable">Acceptabel</option>
              <option value="unacceptable">Niet acceptabel / actie nodig</option>
            </Select>
            <Select
              label={`Wie herstelt bij score ${level.score}?`}
              value={level.repairResponsibility}
              onChange={(value) =>
                patch(level.score, {
                  repairResponsibility: value as ScoreLevel['repairResponsibility'],
                })
              }
            >
              {Object.entries(responsibility).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
            <Select
              label={`Wie betaalt bij score ${level.score}?`}
              value={level.costResponsibility}
              onChange={(value) =>
                patch(level.score, {
                  costResponsibility: value as ScoreLevel['costResponsibility'],
                })
              }
            >
              {Object.entries(responsibility).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          {level.references.map((reference) => (
            <div className={s.scoreReference} key={reference.id}>
              <a
                href={protectedURL(`/api/v1${base}/norm-assets/${reference.assetId}`)}
                target="_blank"
                rel="noreferrer"
              >
                {reference.mime.startsWith('image/') ? (
                  <img
                    src={protectedURL(`/api/v1${base}/norm-assets/${reference.assetId}`)}
                    alt={reference.caption || reference.name}
                  />
                ) : (
                  reference.name
                )}
              </a>
              <Field
                label="Toelichting referentie"
                value={reference.caption}
                maxLength={2000}
                onChange={(e) =>
                  patch(level.score, {
                    references: level.references.map((ref) =>
                      ref.id === reference.id ? { ...ref, caption: e.target.value } : ref,
                    ),
                  })
                }
              />
              {editable && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    patch(level.score, {
                      references: level.references.filter((ref) => ref.id !== reference.id),
                    })
                  }
                >
                  Referentie verwijderen
                </Button>
              )}
            </div>
          ))}
          {editable && level.references.length < 6 && (
            <label className={s.field}>
              <span>Referentiebestand score {level.score} toevoegen</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  setBusy(true);
                  setError('');
                  try {
                    if (file.size > 20 * 1048576)
                      throw new Error('Maximaal 20 MiB per referentiebestand.');
                    const assetId = uuid();
                    await api(`${base}/norm-assets/${assetId}`, {
                      method: 'PUT',
                      headers: {
                        'Content-Type': file.type,
                        'X-File-Name': encodeURIComponent(file.name),
                      },
                      body: file,
                    });
                    await loadProtectedResource(`/api/v1${base}/norm-assets/${assetId}`);
                    patch(level.score, {
                      references: [
                        ...level.references,
                        { id: uuid(), assetId, name: file.name, mime: file.type, caption: '' },
                      ],
                    });
                  } catch (error) {
                    setError(errorText(error));
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </label>
          )}
        </fieldset>
      ))}
    </section>
  );
}

export function ScoreFields({
  rule,
  value,
  disabled,
  onChange,
  org,
}: {
  org: string;
  rule: NormRule;
  value?: ScoreDetail | null;
  disabled: boolean;
  onChange: (value: ScoreDetail, outcome?: 'acceptable' | 'unacceptable') => void;
}) {
  const levels = rule.scoreLevels || [];
  if (!levels.length) return null;
  const detail: ScoreDetail = value || {
    score: null,
    repairResponsibility: 'undetermined',
    costResponsibility: 'undetermined',
    note: '',
  };
  const level = levels.find((level) => level.score === detail.score);
  return (
    <fieldset className={`${s.scoreLevel} ${s.stack}`} disabled={disabled}>
      <legend>Conditie en verantwoordelijkheid</legend>
      <Select
        label="Bevestigde score"
        value={detail.score?.toString() || ''}
        onChange={(raw) => {
          const next = levels.find((level) => level.score === Number(raw));
          onChange(
            next
              ? {
                  score: next.score,
                  repairResponsibility: next.repairResponsibility,
                  costResponsibility: next.costResponsibility,
                  note: '',
                }
              : { ...detail, score: null },
            next?.outcome || undefined,
          );
        }}
      >
        <option value="">Geen numerieke score</option>
        {levels.map((level) => (
          <option value={level.score} key={level.score}>
            {level.score} · {level.label}
          </option>
        ))}
      </Select>
      {level && <p>{level.description}</p>}
      <Select
        label="Herstelverantwoordelijkheid"
        value={detail.repairResponsibility}
        onChange={(value) =>
          onChange({
            ...detail,
            repairResponsibility: value as ScoreDetail['repairResponsibility'],
          })
        }
      >
        {Object.entries(responsibility).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </Select>
      <Select
        label="Kostenverantwoordelijkheid"
        value={detail.costResponsibility}
        onChange={(value) =>
          onChange({ ...detail, costResponsibility: value as ScoreDetail['costResponsibility'] })
        }
      >
        {Object.entries(responsibility).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </Select>
      <Field
        label="Toelichting verantwoordelijkheid"
        value={detail.note}
        maxLength={2000}
        onChange={(e) => onChange({ ...detail, note: e.target.value })}
      />
      {!!level?.references.length && (
        <div className={s.referenceLinks}>
          {level.references.map((ref) => (
            <a
              key={ref.id}
              href={protectedURL(`/api/v1/orgs/${org}/norm-assets/${ref.assetId}`)}
              target="_blank"
              rel="noreferrer"
            >
              {ref.caption || ref.name}
            </a>
          ))}
        </div>
      )}
    </fieldset>
  );
}
export function ScoreSummary({ value }: { value?: ScoreDetail | null }) {
  return value?.score != null ? (
    <p className={s.muted}>
      Score {value.score} · Herstel: {responsibility[value.repairResponsibility]} · Kosten:{' '}
      {responsibility[value.costResponsibility]}
      {value.note ? ` · ${value.note}` : ''}
    </p>
  ) : null;
}
