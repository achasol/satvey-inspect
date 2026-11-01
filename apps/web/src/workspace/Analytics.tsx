import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Field } from '../components/ui';
import { useResource } from './useResource';
import { Select, ErrorNotice } from './shared';
import { savePlatformFile } from './platform';
import s from './workspace.module.css';

type Data = {
  summary: {
    completedVisits: number;
    activeMinutes: number;
    reportRevisions: number;
    propertyIssues: number;
    openAgreements: number;
    measuredVisits: number;
  };
  inspectors: {
    id: string;
    name: string;
    visits: number;
    reports: number;
    versions: number;
    activeMinutes: number;
    medianMinutes: number;
  }[];
  trend: { day: string; completed: number; capture: number; review: number; report: number }[];
  criteria: Record<string, number>;
  rooms: Record<string, number>;
  properties: { id: string; address: string; issues: number }[];
  issues: {
    propertyId: string;
    address: string;
    inspectionId: string;
    room: string;
    criterion: string;
    element: string;
    score: number | null;
    date: string;
  }[];
};
const number = (value: number) =>
  new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 1 }).format(value);
const date = (value: Date) =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;

function Bars({
  title,
  rows,
  colour = 'var(--primary)',
  onSelect,
}: {
  title: string;
  rows: { label: string; value: number }[];
  colour?: string;
  onSelect?: (label: string) => void;
}) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <section className={`${s.panel} ${s.analyticsChart}`}>
      <h2>{title}</h2>
      {!rows.length ? (
        <p className={s.muted}>Nog geen gegevens voor deze selectie.</p>
      ) : (
        <>
          <svg
            role="img"
            aria-label={title}
            viewBox={`0 0 600 ${Math.max(100, rows.length * 46 + 12)}`}
          >
            <title>{title}</title>
            {rows.map((row, index) => (
              <g key={row.label}>
                <text x="0" y={index * 46 + 18} fontSize="12" fill="currentColor">
                  {row.label.length > 34 ? row.label.slice(0, 32) + '…' : row.label}
                </text>
                <rect
                  x="0"
                  y={index * 46 + 26}
                  width={Math.max(0, (row.value / max) * 535)}
                  height="12"
                  rx="5"
                  fill={colour}
                >
                  <title>
                    {row.label}: {number(row.value)}
                  </title>
                </rect>
                <text x="545" y={index * 46 + 36} fontSize="12" fill="currentColor">
                  {number(row.value)}
                </text>
              </g>
            ))}
          </svg>
          <details>
            <summary>Grafiekgegevens als tabel</summary>
            <table className={s.historyTable}>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label}>
                    <th>
                      {onSelect ? (
                        <button className={s.textButton} onClick={() => onSelect(row.label)}>
                          {row.label}
                        </button>
                      ) : (
                        row.label
                      )}
                    </th>
                    <td>{number(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </section>
  );
}
function Trend({ rows, onSelect }: { rows: Data['trend']; onSelect: (day: string) => void }) {
  const max = Math.max(1, ...rows.map((row) => row.completed));
  const points = rows
    .map(
      (row, index) =>
        `${20 + (index / Math.max(1, rows.length - 1)) * 560},${155 - (row.completed / max) * 125}`,
    )
    .join(' ');
  return (
    <section className={`${s.panel} ${s.analyticsChart}`}>
      <h2>Afgeronde inspecties</h2>
      <svg role="img" aria-label="Afgeronde inspecties per dag" viewBox="0 0 600 195">
        <title>Afgeronde inspecties per dag</title>
        <path d="M20 30V155H580" fill="none" stroke="var(--border)" />
        <polyline points={points} fill="none" stroke="var(--primary)" strokeWidth="3" />
        {rows.map((row, index) => (
          <circle
            key={row.day}
            cx={20 + (index / Math.max(1, rows.length - 1)) * 560}
            cy={155 - (row.completed / max) * 125}
            r="4"
            fill="var(--primary)"
          >
            <title>
              {row.day}: {row.completed}
            </title>
          </circle>
        ))}
        <text x="20" y="185" fontSize="12" fill="currentColor">
          {rows[0]?.day}
        </text>
        <text x="580" y="185" textAnchor="end" fontSize="12" fill="currentColor">
          {rows.at(-1)?.day}
        </text>
      </svg>
      <details>
        <summary>Daggegevens bekijken</summary>
        <table className={s.historyTable}>
          <thead>
            <tr>
              <th>Datum</th>
              <th>Afgerond</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.day}>
                <td>
                  <button className={s.textButton} onClick={() => onSelect(row.day)}>
                    {row.day}
                  </button>
                </td>
                <td>{row.completed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
export function Analytics({ base, scope }: { base: string; scope: string }) {
  const [from, setFrom] = useState(() => date(new Date(Date.now() - 29 * 86400000))),
    [to, setTo] = useState(() => date(new Date())),
    [kind, setKind] = useState(''),
    [inspector, setInspector] = useState(''),
    [property, setProperty] = useState(''),
    [complex, setComplex] = useState(''),
    [criterion, setCriterion] = useState(''),
    [roomFilter, setRoomFilter] = useState('');
  const params = new URLSearchParams({ from, to, kind, inspector, property, complex });
  const { data, error } = useResource<Data>(scope, `${base}/analytics?${params}`);
  const filteredIssues = (data?.issues || []).filter(
    (issue) =>
      (!criterion || issue.criterion === criterion) && (!roomFilter || issue.room === roomFilter),
  );
  const focusIssues = () =>
    document.getElementById('analytics-issues')?.scrollIntoView({ block: 'start' });
  async function csv() {
    if (!data) return;
    const columns = [
      'inspecteur',
      'gemeten bezoeken',
      'vastgestelde bezoeken',
      'extra rapportversies',
      'actieve minuten',
      'mediaan minuten per bezoek',
    ];
    const escape = (value: unknown) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
    const rows = data.inspectors.map((row) => [
      row.name,
      row.visits,
      row.reports,
      row.versions,
      row.activeMinutes.toFixed(1),
      row.medianMinutes.toFixed(1),
    ]);
    await savePlatformFile(
      new Blob(
        ['\uFEFF' + [columns, ...rows].map((row) => row.map(escape).join(';')).join('\r\n')],
        { type: 'text/csv;charset=utf-8' },
      ),
      'satvey-analytics.csv',
    );
  }
  return (
    <section className={s.stack}>
      <div className={s.pageHeading}>
        <div>
          <p className={s.eyebrow}>Organisatie-inzicht</p>
          <h1>Analytics</h1>
          <p className={s.muted}>Inspecteursprestaties en aandachtspunten in het vastgoed.</p>
        </div>
        <Button variant="secondary" disabled={!data} onClick={() => void csv()}>
          CSV downloaden
        </Button>
      </div>
      <div className={s.analyticsFilters}>
        <Field label="Van" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Field label="Tot en met" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <Select label="Inspectietype" value={kind} onChange={setKind}>
          <option value="">Alle types</option>
          <option value="pre">Voorinspectie</option>
          <option value="final">Eindinspectie</option>
        </Select>
        <Select label="Inspecteur" value={inspector} onChange={setInspector}>
          <option value="">Alle inspecteurs</option>
          {data?.inspectors.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </Select>
        <Field
          label="Pand of objectnummer"
          value={property}
          onChange={(e) => setProperty(e.target.value)}
        />
        <Field label="Complex" value={complex} onChange={(e) => setComplex(e.target.value)} />
      </div>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {!data && !error && <p role="status">Analytics laden…</p>}
      {data && (
        <>
          <dl className={s.analyticsSummary}>
            {[
              ['Afgeronde bezoeken', data.summary.completedVisits],
              ['Geschatte actieve minuten', number(data.summary.activeMinutes)],
              ['Aandachtspunten', data.summary.propertyIssues],
              ['Open afspraken bij gestarte bezoeken', data.summary.openAgreements],
            ].map(([label, value]) => (
              <div className={s.panel} key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className={s.muted}>
            Tijd wordt automatisch geschat uit actieve opname- en appmomenten.{' '}
            {data.summary.measuredVisits} bezoeken met meetgegevens. Oudere handmatige metingen zijn
            niet meegerekend. Rapportversies zijn geen nieuwe bezoeken en geen automatische
            kwaliteitsbeoordeling.
          </p>
          <div className={s.analyticsGrid}>
            <Trend
              rows={data.trend}
              onSelect={(day) => {
                setFrom(day);
                setTo(day);
              }}
            />
            <Bars
              title="Actieve minuten per fase"
              rows={['capture', 'review', 'report'].map((phase, index) => ({
                label: ['Opnemen', 'Beoordelen', 'Rapport'][index],
                value: data.trend.reduce((sum, row) => sum + row[phase as 'capture'], 0),
              }))}
            />
            <Bars
              title="Terugkerende aandachtspunten"
              onSelect={(label) => {
                setCriterion(label);
                focusIssues();
              }}
              rows={Object.entries(data.criteria)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([label, value]) => ({ label, value }))}
            />
            <Bars
              title="Aandachtspunten per ruimte"
              onSelect={(label) => {
                setRoomFilter(label);
                focusIssues();
              }}
              rows={Object.entries(data.rooms)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([label, value]) => ({ label, value }))}
            />
          </div>
          <section className={`${s.panel} ${s.stack}`}>
            <h2>Inspecteurs</h2>
            <div className={s.tableScroll}>
              <table className={s.historyTable}>
                <thead>
                  <tr>
                    <th>Inspecteur</th>
                    <th>Gemeten bezoeken</th>
                    <th>Vastgesteld</th>
                    <th>Extra versies</th>
                    <th>Actieve minuten</th>
                    <th>Mediaan per bezoek</th>
                  </tr>
                </thead>
                <tbody>
                  {data.inspectors.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <button className={s.textButton} onClick={() => setInspector(row.id)}>
                          {row.name}
                        </button>
                      </td>
                      <td>{row.visits}</td>
                      <td>{row.reports}</td>
                      <td>{row.versions}</td>
                      <td>{number(row.activeMinutes)}</td>
                      <td>{row.visits ? number(row.medianMinutes) : 'Nog niet gemeten'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.inspectors.length && <p>Nog geen inspecteurgegevens voor deze selectie.</p>}
          </section>
          <section className={`${s.panel} ${s.stack}`}>
            <h2 id="analytics-issues">Panden met aandachtspunten</h2>
            <div className={s.elementFilters}>
              <Select
                label="Criterium in aandachtspunten"
                value={criterion}
                onChange={setCriterion}
              >
                <option value="">Alle criteria</option>
                {Object.keys(data.criteria).map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </Select>
              <Select label="Ruimte in aandachtspunten" value={roomFilter} onChange={setRoomFilter}>
                <option value="">Alle ruimtes</option>
                {Object.keys(data.rooms).map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
            <div className={s.tableScroll}>
              <table className={s.historyTable}>
                <thead>
                  <tr>
                    <th>Pand</th>
                    <th>Ruimte</th>
                    <th>Criterium</th>
                    <th>Score</th>
                    <th>Inspectie</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredIssues.slice(0, 100).map((issue, index) => (
                    <tr key={index}>
                      <td>
                        <Link to={`/app/properties/${issue.propertyId}`}>{issue.address}</Link>
                      </td>
                      <td>{issue.room}</td>
                      <td>{issue.criterion}</td>
                      <td>{issue.score || 'Niet vastgelegd'}</td>
                      <td>
                        <Link to={`/app/inspections/${issue.inspectionId}/report`}>
                          {issue.date}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!filteredIssues.length && (
              <p>Geen bevestigde niet-acceptabele beoordelingen in deze selectie.</p>
            )}
            {filteredIssues.length > 100 && (
              <p>
                De eerste 100 aandachtspunten worden getoond. Verfijn de filters voor meer detail.
              </p>
            )}
          </section>
        </>
      )}
    </section>
  );
}
