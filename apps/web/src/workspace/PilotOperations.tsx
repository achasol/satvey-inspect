import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Field } from '../components/ui';
import { api, json } from './api';
import { platformFetch, savePlatformFile } from './platform';
import { useResource } from './useResource';
import { announceRefresh, ErrorNotice, errorText } from './shared';
import s from './workspace.module.css';

type Policy = {
  reportDays: number | null;
  audioDays: number | null;
  transcriptDays: number | null;
  enabled: boolean;
  version: number;
};
type RetentionData = { policy: Policy; preview: Record<string, number>; note: string };
export function PilotSettings({ base, scope }: { base: string; scope: string }) {
  const { data, error } = useResource<RetentionData>(scope, `${base}/retention`),
    { data: offline } = useResource<{ hours: number; version: number }>(
      scope,
      `${base}/offline-settings`,
    );
  return (
    <div className={s.stack}>
      <h2>Pilot en gegevensbeheer</h2>
      <ol>
        <li>
          <Link to="/app/settings?tab=properties">
            Vastgoedbron importeren en koppeling controleren
          </Link>
        </li>
        <li>
          <Link to="/app/norms">Kwaliteitskader controleren en publiceren</Link>
        </li>
        <li>
          <Link to="/app/formats">
            Voor- en eindinspectiesjabloon met bewijseisen en ondertekenverklaring publiceren
          </Link>
        </li>
        <li>
          <Link to="/app/settings?tab=roles">
            Planning, kwaliteitscontrole en verwijderrechten toekennen
          </Link>
        </li>
        <li>
          Een volledig proefbezoek uitvoeren op iOS en Android, inclusief herstel en
          rapportverzending.
        </li>
        <li>Bewaartermijnen, ondersteuning en ontvangende systemen met de klant vastleggen.</li>
      </ol>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {offline && <OfflineSettings key={offline.version} base={base} initial={offline} />}
      {data && <RetentionSettings key={data.policy.version} base={base} data={data} />}
      <ExitExport base={base} />
    </div>
  );
}
function OfflineSettings({
  base,
  initial,
}: {
  base: string;
  initial: { hours: number; version: number };
}) {
  const [hours, setHours] = useState(initial.hours),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className={s.panel}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await api(`${base}/offline-settings`, json('PUT', { hours, version: initial.version }));
          announceRefresh();
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Offline toegang op bedrijfsapparaten</h3>
      <p>
        De termijn start bij online autorisatie. Verlopen toegang vergrendelt de app;
        niet-gesynchroniseerd werk blijft bewaard.
      </p>
      <Field
        label="Offline toegang in uren"
        type="number"
        min={1}
        max={168}
        value={hours}
        onChange={(e) => setHours(Number(e.target.value))}
      />
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <Button type="submit" loading={busy}>
        Offline beleid bewaren
      </Button>
    </form>
  );
}
function RetentionSettings({ base, data }: { base: string; data: RetentionData }) {
  const [policy, setPolicy] = useState(data.policy),
    [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function save(enabled: boolean) {
    setBusy(true);
    setError('');
    try {
      await api(`${base}/retention`, json('PUT', { ...policy, enabled }));
      announceRefresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const changed =
    JSON.stringify({ ...policy, enabled: data.policy.enabled }) !== JSON.stringify(data.policy);
  return (
    <section className={`${s.panel} ${s.stack}`}>
      <h3>Bewaarbeleid</h3>
      <p>
        {data.policy.enabled
          ? 'Automatische uitvoering actief'
          : 'Automatische verwijdering uitgeschakeld'}
        . Lege termijnen behouden de betreffende gegevens.
      </p>
      {(['reportDays', 'audioDays', 'transcriptDays'] as const).map((key) => (
        <Field
          key={key}
          label={
            {
              reportDays: 'Dagen na archivering van een dossier',
              audioDays: 'Dagen voor originele audio na opname',
              transcriptDays: 'Dagen voor interne transcripties na opname',
            }[key]
          }
          type="number"
          min={1}
          max={36500}
          value={policy[key] ?? ''}
          onChange={(e) => {
            setPolicy({ ...policy, [key]: e.target.value ? Number(e.target.value) : null });
            setConfirmed(false);
          }}
        />
      ))}
      <p>{data.note}</p>
      <dl>
        {Object.entries(data.preview).map(([key, count]) => (
          <div key={key}>
            <dt>
              {{
                archivedCandidates: 'Gearchiveerde kandidaten',
                audioFiles: 'Audiobestanden',
                transcripts: 'Transcripties',
                heldDossiers: 'Dossiers met bewaarblokkade',
              }[key] || key}
            </dt>
            <dd>{count}</dd>
          </div>
        ))}
      </dl>
      <Button variant="secondary" loading={busy} onClick={() => void save(false)}>
        Bewaren en voorbeeld verversen (uitgeschakeld)
      </Button>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={changed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />{' '}
        De opgeslagen termijnen en het voorbeeld zijn gecontroleerd en door de klant goedgekeurd.
      </label>
      <Button
        variant="destructive"
        disabled={!confirmed || changed}
        loading={busy}
        onClick={() => void save(true)}
      >
        Bewaarbeleid activeren
      </Button>
      {data.policy.enabled && (
        <Button variant="secondary" loading={busy} onClick={() => void save(false)}>
          Automatische uitvoering stoppen
        </Button>
      )}
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </section>
  );
}
function ExitExport({ base }: { base: string }) {
  const [after, setAfter] = useState(''),
    [before, setBefore] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className={`${s.panel} ${s.stack}`}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          const query = new URLSearchParams({ limit: '10' });
          if (after) query.set('after', after);
          if (before) query.set('before', before);
          const response = await platformFetch(`/api/v1${base}/exit-export?${query}`);
          if (!response.ok) throw new Error((await response.json()).error || 'Export mislukt');
          await savePlatformFile(await response.blob(), 'satvey-exit.zip');
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Organisatie-export</h3>
      <p>
        Download dossiers in delen met bronbestanden en configuratie, zonder aanmeldgeheimen.
        Pauzeer wijzigingen tijdens een volledige exit. Gebruik de cursor en peildatum uit
        manifest.json voor volgende delen; de export is pas volledig als hasMore false is.
      </p>
      <Field
        label="Vervolgcursor (leeg voor eerste deel)"
        value={after}
        onChange={(e) => setAfter(e.target.value)}
      />
      <Field
        label="Peildatum uit manifest (leeg voor eerste deel)"
        value={before}
        onChange={(e) => setBefore(e.target.value)}
      />
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <Button type="submit" loading={busy}>
        Exportdeel downloaden
      </Button>
    </form>
  );
}
type Measurement = {
  captureMinutes: number;
  reviewMinutes: number;
  reportMinutes: number;
  reentryMinutes: number;
  supportMinutes: number;
  note: string;
  version: number;
};
const labels = {
  captureMinutes: 'Opnemen',
  reviewMinutes: 'Beoordelen en corrigeren',
  reportMinutes: 'Rapport voorbereiden',
  reentryMinutes: 'Overtypen in ander systeem',
  supportMinutes: 'Ondersteuning',
};
export function VisitMeasurement({
  path,
  scope,
  editable,
}: {
  path: string;
  scope: string;
  editable: boolean;
}) {
  const { data, error } = useResource<Measurement[]>(scope, `${path}/measurement`);
  return (
    <>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {data && (
        <MeasurementForm
          key={data[0]?.version || 0}
          path={path}
          editable={editable}
          initial={
            data[0] || {
              captureMinutes: 0,
              reviewMinutes: 0,
              reportMinutes: 0,
              reentryMinutes: 0,
              supportMinutes: 0,
              note: '',
              version: 0,
            }
          }
        />
      )}
    </>
  );
}
function MeasurementForm({
  path,
  initial,
  editable,
}: {
  path: string;
  initial: Measurement;
  editable: boolean;
}) {
  const [value, setValue] = useState(initial),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className={s.stack}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await api(`${path}/measurement`, json('PUT', value));
          announceRefresh();
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p>
        Meet actieve minuten, inclusief correcties en overtypen. Noteer wachttijd apart. Gebruik
        geen bewonersgegevens in de toelichting.
      </p>
      <fieldset disabled={!editable || busy} className={s.stack}>
        {Object.entries(labels).map(([key, label]) => (
          <Field
            key={key}
            label={`${label} (minuten)`}
            type="number"
            min={0}
            max={1440}
            step="0.1"
            value={value[key as keyof typeof labels]}
            onChange={(e) => setValue({ ...value, [key]: Number(e.target.value) })}
          />
        ))}
        <Field
          label="Meetcontext en wachttijd"
          value={value.note}
          maxLength={1000}
          onChange={(e) => setValue({ ...value, note: e.target.value })}
        />
      </fieldset>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {editable && (
        <Button type="submit" loading={busy}>
          Meting bewaren
        </Button>
      )}
    </form>
  );
}
type MetricRow = {
  id: string;
  kind: string;
  status: string;
  correction: boolean;
  visitOutcome: string;
  reviewStatus: string;
  captureMinutes: number | null;
  reviewMinutes: number | null;
  reportMinutes: number | null;
  reentryMinutes: number | null;
  supportMinutes: number | null;
  deliveryProblems: number;
  processingFailures: number;
};
export function PilotDashboard({ base, scope }: { base: string; scope: string }) {
  const { data, error } = useResource<{
    rows: MetricRow[];
    measurement: string;
    generatedAt: string;
  }>(scope, `${base}/pilot-metrics`);
  const visits = data?.rows.filter((r) => !r.correction) || [],
    measured = visits.filter((r) => r.captureMinutes !== null);
  const totals = measured
    .map(
      (r) =>
        (r.captureMinutes || 0) +
        (r.reviewMinutes || 0) +
        (r.reportMinutes || 0) +
        (r.reentryMinutes || 0),
    )
    .sort((a, b) => a - b);
  const mean = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null,
    median = totals.length
      ? (totals[Math.floor((totals.length - 1) / 2)] + totals[Math.floor(totals.length / 2)]) / 2
      : null;
  return (
    <section className={s.stack}>
      <h1>Pilotoverzicht</h1>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <p>{data?.measurement} Correctierapporten tellen afzonderlijk van nieuwe bezoeken.</p>
      <dl>
        {Object.entries({
          Pogingen: visits.length,
          Vastgelegd: visits.filter((r) => r.status === 'final').length,
          Correcties: data?.rows.filter((r) => r.correction).length || 0,
          'Gemeten bezoeken': measured.length,
          'Gemiddeld actieve minuten': mean === null ? 'Niet gemeten' : mean.toFixed(1),
          'Mediaan actieve minuten': median === null ? 'Niet gemeten' : median.toFixed(1),
          Overdrachtsproblemen: data?.rows.reduce((n, r) => n + r.deliveryProblems, 0) || 0,
          Verwerkingsfouten: data?.rows.reduce((n, r) => n + r.processingFailures, 0) || 0,
        }).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <Button
        variant="secondary"
        disabled={!data}
        onClick={() => {
          if (!data) return;
          const keys = [
            'id',
            'kind',
            'status',
            'correction',
            'visitOutcome',
            'captureMinutes',
            'reviewMinutes',
            'reportMinutes',
            'reentryMinutes',
            'supportMinutes',
            'deliveryProblems',
            'processingFailures',
          ] as const;
          const csv = [
            keys.join(','),
            ...data.rows.map((r) => keys.map((k) => r[k] ?? '').join(',')),
          ].join('\r\n');
          void savePlatformFile(
            new Blob([csv], { type: 'text/csv;charset=utf-8' }),
            'satvey-pilot.csv',
          );
        }}
      >
        Metingen als CSV downloaden
      </Button>
      {visits.map((r) => (
        <Link
          key={r.id}
          to={`/app/inspections/${r.id}/${r.status === 'final' ? 'report' : 'capture'}`}
        >
          {r.id} · {r.kind === 'pre' ? 'Voorinspectie' : 'Eindinspectie'} · {r.visitOutcome}
        </Link>
      ))}
    </section>
  );
}
