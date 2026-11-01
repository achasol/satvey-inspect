import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui';
import { api, json, type Inspection } from './api';
import { useResource } from './useResource';
import { announceRefresh, ErrorNotice, errorText } from './shared';
import s from './workspace.module.css';

export function ReportVersions({
  path,
  scope,
  inspection,
  editable,
}: {
  path: string;
  scope: string;
  inspection: Inspection;
  editable: boolean;
}) {
  const { data } = useResource<
    { id: string; number: number; createdAt: string; createdBy: string }[]
  >(scope, `${path}/report/versions`);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    navigate = useNavigate();
  return (
    <section className={s.stack} aria-label="Rapportversies">
      {editable && inspection.status === 'final' && !inspection.archivedAt && (
        <Button
          variant="secondary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await api(
                `${path}/report/reopen`,
                json('POST', { version: inspection.revision, reportId: inspection.latestReportId }),
              );
              announceRefresh();
              navigate(`/app/inspections/${inspection.id}/review`, { replace: true });
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Bewerken
        </Button>
      )}
      {inspection.status === 'draft' && inspection.latestReportId && (
        <p className={s.muted}>
          Je werkt aan een nieuwe conceptversie. Het eerder vastgestelde rapport blijft beschikbaar
          totdat je deze versie opnieuw vastlegt en ondertekent.
        </p>
      )}
      {!!data?.length && (
        <details>
          <summary>Vastgestelde rapportversies ({data.length})</summary>
          <ul className={s.versionList}>
            {data.map((version) => (
              <li key={version.id}>
                <Link to={`/app/inspections/${inspection.id}/report?reportId=${version.id}`}>
                  Versie {version.number}
                </Link>
                <span>
                  {new Date(version.createdAt).toLocaleString('nl-NL')} · {version.createdBy}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </section>
  );
}
