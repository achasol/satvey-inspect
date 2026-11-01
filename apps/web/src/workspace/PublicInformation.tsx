import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';
import { errorText, ErrorNotice } from './shared';
import s from './workspace.module.css';
type Information = {
  app: string;
  entity: string;
  supportEmail: string;
  privacyURL: string;
  hostingRegion: string;
};
export function PublicInformation() {
  const [data, setData] = useState<Information>(),
    [error, setError] = useState('');
  useEffect(() => {
    void api<Information>('/public-information')
      .then(setData)
      .catch((e) => setError(errorText(e)));
  }, []);
  const deletion = location.pathname === '/account-deletion',
    privacy = location.pathname === '/privacy';
  return (
    <main className={s.login}>
      <section className={s.loginPanel}>
        <Link to="/app">Satvey Inspect</Link>
        <h1>
          {deletion
            ? 'Account en gegevens verwijderen'
            : privacy
              ? 'Privacy en gegevensgebruik'
              : 'Ondersteuning'}
        </h1>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        {data && (
          <>
            <p>{data.entity || 'Satvey Inspect'}</p>
            {privacy && (
              <>
                <p>
                  Satvey Inspect verwerkt accountgegevens, woninggegevens, inspectiefoto’s, audio,
                  transcripties, beoordelingen, afspraken en handtekeningen om inspecties uit te
                  voeren en rapporten over te dragen. De woningcorporatie bepaalt de afgesproken
                  toepassing en bewaartermijnen.
                </p>
                <p>
                  Foto’s en audio kunnen voor analyse en transcriptie naar de geconfigureerde
                  verwerkingsleveranciers worden gestuurd. Definitieve rapporten en geselecteerd
                  bewijs worden na goedkeuring gedeeld via de ingestelde kanalen. Bewonersrapporten
                  kunnen als e-mailbijlage worden verzonden.
                </p>
                <p>
                  Gedownloade bezoeken worden op het bedrijfsapparaat opgeslagen voor offline werk.
                  Camera- en microfoontoegang worden gebruikt voor het opnemen van bewijs.
                </p>
                {data.hostingRegion && <p>Hostingregio: {data.hostingRegion}</p>}
                {/^https:\/\//.test(data.privacyURL) && (
                  <a href={data.privacyURL}>
                    Volledige privacyverklaring en verwerkingsleveranciers
                  </a>
                )}
              </>
            )}
            {deletion && (
              <>
                <p>
                  Open Instellingen → Account → Account verwijderen in de app. Bevestig met je
                  e-mailadres na opnieuw aanmelden. Draag eventueel eerst het organisatiebeheer
                  over.
                </p>
                <p>
                  Kun je niet aanmelden, vraag verwijdering aan via het onderstaande
                  ondersteuningsadres. Vermeld je accountadres en organisatie; stuur geen
                  wachtwoorden of inspectiebewijs mee.
                </p>
                <p>
                  Accountverwijdering beëindigt je toegang. Corporatiedossiers en historische
                  rapporten worden bewaard of verwijderd volgens het afgesproken bewaarbeleid.
                </p>
              </>
            )}
            {data.supportEmail ? (
              <a href={`mailto:${data.supportEmail}`}>{data.supportEmail}</a>
            ) : (
              <p>Het ondersteuningsadres wordt door de beheerder geconfigureerd.</p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
