// Explicit local-only demo setup. All addresses, evidence and policy are fictional.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const endpoint = process.env.DEMO_API_URL || 'http://api:8080/api/v1';
if (
  !['api', 'localhost', '127.0.0.1', 'host.docker.internal'].includes(new URL(endpoint).hostname)
) {
  throw new Error('This fixture generator only runs against a local API.');
}
const email = process.env.DEMO_EMAIL || 'demo@desleutels.local';
const password = process.env.DEMO_PASSWORD || 'SleutelsDemo2026!';
const uid = (label) => {
  const h = createHash('sha256').update(`satvey-desleutels-demo-v1:${label}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
class Client {
  cookie = '';
  async request(method, path, body, extra = {}) {
    const headers = { 'X-Satvey-Request': '1', ...extra };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined && !Buffer.isBuffer(body)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const res = await fetch(`${endpoint}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(90000),
    });
    const cookies = res.headers.getSetCookie();
    if (cookies.length) this.cookie = cookies.map((value) => value.split(';')[0]).join('; ');
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.headers.get('Content-Type')?.includes('application/json')
      ? res.json()
      : Buffer.from(await res.arrayBuffer());
  }
}
const client = new Client();
await client.request('POST', '/auth/login', { email, password });
const account = await client.request('GET', '/me');
const org = account.organisations.find((value) => value.slug === 'desleutels-demo');
if (!org || !org.name.toLowerCase().includes('demo'))
  throw new Error('Create the separate desleutels-demo organisation first.');
const base = `/orgs/${org.id}`;
const progressPath = resolve(root, '.cache/sleutels-demo-progress.json');
let progress = { orgId: org.id, completed: [] };
try {
  const saved = JSON.parse(await readFile(progressPath, 'utf8'));
  if (saved.orgId === org.id) progress = saved;
} catch {}
const saveProgress = async () => {
  await mkdir(dirname(progressPath), { recursive: true });
  await writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`);
};
console.log(`Preparing ${org.name} (${org.slug})`);

// Share access with the existing local administrator through the actual invitation flow.
const members = await client.request('GET', `${base}/members`);
if (!members.some((member) => member.email === 'admin@satvey.local')) {
  const admin = new Client();
  await admin.request('POST', '/auth/login', {
    email: process.env.DEMO_EXISTING_ADMIN_EMAIL || 'admin@satvey.local',
    password: process.env.DEMO_EXISTING_ADMIN_PASSWORD || 'local-inspection-2026',
  });
  const invitation = await client.request('POST', `${base}/invitations`, {
    email: 'admin@satvey.local',
    role: 'admin',
  });
  await admin.request('POST', '/invitations/accept', {
    token: new URL(invitation.url).searchParams.get('token'),
  });
}

const sourceId = uid('source');
const sources = await client.request('GET', `${base}/property-sources`);
if (!sources.sources.some((source) => source.id === sourceId)) {
  await client.request('POST', `${base}/property-sources`, {
    id: sourceId,
    name: 'De Sleutels · Fictief demobezit',
    administration: 'SLEUTELS-DEMO-LEIDEN',
    kind: 'csv',
    enabled: true,
  });
}
const homes = [
  [
    'DEMO-LEI-001',
    'Lakenstraat 24 (demo)',
    '2311 AA',
    'Demo · Binnenstad',
    'Appartement',
    1978,
    68,
  ],
  [
    'DEMO-LEI-002',
    'Singelhof 8-A (demo)',
    '2312 AB',
    'Demo · Binnenstad',
    'Portiekwoning',
    1982,
    74,
  ],
  ['DEMO-LEI-003', 'Rijnkade 42 (demo)', '2315 AC', 'Demo · Leiden Noord', 'Appartement', 1976, 63],
  ['DEMO-LEI-004', 'Molenpad 16 (demo)', '2321 AD', 'Demo · Zuidwest', 'Eengezinswoning', 1988, 91],
  [
    'DEMO-LEI-005',
    'Zijlpoort 36 (demo)',
    '2316 AE',
    'Demo · Leiden Noord',
    'Appartement',
    1972,
    58,
  ],
  ['DEMO-LEI-006', 'Plantsoenhof 7 (demo)', '2313 AF', 'Demo · Tuinstad', 'Maisonnette', 1990, 83],
  ['DEMO-LEI-007', 'Rijnzicht 13 (demo)', '2324 AG', 'Demo · Zuidwest', 'Appartement', 2006, 81],
  [
    'DEMO-LEI-008',
    'Professorenhof 22 (demo)',
    '2313 AH',
    'Demo · Tuinstad',
    'Seniorenwoning',
    1998,
    72,
  ],
];
const csv =
  [
    'sourceObjectId,objectNumber,address,postcode,city,complexId,complexName,objectType,buildYear,area,areaType,areaUnit,sourceStatus',
    ...homes.map((home, i) =>
      [
        home[0],
        `VHE-${String(i + 1).padStart(5, '0')}`,
        home[1],
        home[2],
        'Leiden',
        `DEMO-C${(i % 4) + 1}`,
        home[3],
        home[4],
        home[5],
        home[6],
        'Gebruiksoppervlakte (demowaarde)',
        'm2',
        i === 3 ? 'Verhuurd' : 'In mutatie',
      ].join(','),
    ),
  ].join('\n') + '\n';
await writeFile(resolve(root, 'demo/sleutels/properties.csv'), csv);
const preview = await client.request('POST', `${base}/property-sources/${sourceId}/imports`, {
  csv,
});
if (preview.errors.length) throw new Error(preview.errors.join('\n'));
await client.request(
  'POST',
  `${base}/property-sources/${sourceId}/imports/${preview.id}/confirm`,
  {},
);
const catalog = await client.request('GET', `${base}/properties?q=DEMO-LEI-`);
const properties = new Map(catalog.items.map((property) => [property.sourceObjectId, property]));
console.log(`Catalog: ${homes.length} fictional Leiden properties`);

const images = Object.fromEntries(
  await Promise.all(
    ['bathroom', 'kitchen', 'hallway', 'living-room', 'bedroom', 'exterior'].map(async (name) => [
      name,
      await readFile(resolve(root, `demo/sleutels/images/${name}.png`)),
    ]),
  ),
);
const normName = 'De Sleutels · Demokwaliteit 2026';
const norms = await client.request('GET', `${base}/norms`);
let norm = norms.find((value) => value.name === normName);
if (!norm) norm = await client.request('POST', `${base}/norms`, { name: normName, baseline: true });
norm = await client.request('GET', `${base}/norms/${norm.id}`);
if (norm.status === 'draft') {
  norm.description =
    'Fictief demonstratiekader voor een lokale Satvey-demo. Deze criteria zijn geen officieel beleid van De Sleutels. Voorbeelden en vastgoedgegevens zijn synthetisch; er zijn geen bewonersgegevens opgenomen.';
  const exampleAssets = [
    [
      'VOCHT',
      'acceptable',
      'hallway',
      'Synthetisch voorbeeld: de getoonde wandvlakken in de entree zijn droog en zonder zichtbare vochtkringen.',
    ],
    [
      'KIT',
      'unacceptable',
      'bathroom',
      'Synthetisch voorbeeld: onregelmatige aansluiting in de douchehoek; inspecteer en herstel de plaatselijke onderbreking. Dit beeld bewijst geen lekkageoorzaak.',
    ],
    [
      'KEUKEN',
      'unacceptable',
      'kitchen',
      'Synthetisch voorbeeld: een scheve kastdeur en beschadiging aan de rand van het werkblad vragen herstelbeoordeling.',
    ],
  ];
  for (const [code, outcome, image, caption] of exampleAssets) {
    const assetId = uid(`norm-asset:${image}`);
    await client.request('PUT', `${base}/norm-assets/${assetId}`, images[image], {
      'Content-Type': 'image/png',
      'X-File-Name': `Demo-${image}.png`,
    });
    const rule = norm.rules.find((value) => value.code === code);
    if (rule) {
      const example = rule.examples.find((value) => value.outcome === outcome);
      if (example) {
        example.assetId = assetId;
        example.caption = caption;
      }
    }
  }
  await client.request('PUT', `${base}/norms/${norm.id}`, norm);
  norm = await client.request('GET', `${base}/norms/${norm.id}`);
  await client.request('POST', `${base}/norms/${norm.id}/publish`, { revision: norm.revision });
  norm = await client.request('GET', `${base}/norms/${norm.id}`);
}
console.log(`Published norm framework: ${norm.rules.length} measures and illustrated examples`);

const roomSpecs = [
  {
    name: 'Entree',
    image: 'hallway',
    code: 'VOCHT',
    text: 'De getoonde entree is leeg en opgeruimd. De zichtbare wandvlakken zijn droog; lichte gebruikssporen bij de onderzijde van het kozijn.',
    outcome: 'acceptable',
    reason:
      'Op de vastgelegde wandvlakken zijn geen vochtkringen of donkere vochtplekken zichtbaar.',
    finding: [
      'Entree: zichtbare afwerking intact',
      'De getoonde deur, vloer en wandafwerking hebben normale lichte gebruikssporen. De foto bevat geen functionele sluitproef.',
      'Gebruikssporen',
    ],
  },
  {
    name: 'Woonkamer',
    image: 'living-room',
    code: 'VOCHT',
    text: 'Lege woonkamer met laminaat, witte wanden en radiator. De zichtbare vloerdelen en wandvlakken zijn netjes; geen opvallende vochtverkleuring in beeld.',
    outcome: 'acceptable',
    reason:
      'De getoonde wandvlakken zijn droog en zonder zichtbare vochtplekken. Achterliggende constructies zijn niet beoordeeld.',
  },
  {
    name: 'Keuken',
    image: 'kitchen',
    code: 'KEUKEN',
    text: 'De onderkasten en het werkblad zijn vastgelegd. Eén kastdeur hangt scheef en de voorrand van het werkblad heeft een plaatselijke beschadiging.',
    outcome: 'unacceptable',
    reason:
      'De scheve kastdeur en beschadigde werkbladrand voldoen niet aan het gekozen demonstratiecriterium; herstel laten beoordelen.',
    finding: [
      'Kastdeur stellen en werkbladrand herstellen',
      'De deur onder het aanrecht hangt scheef met een ongelijkmatige naad. Aan de voorrand van het werkblad is een plaatselijke afsplintering zichtbaar. Controleer de scharnieren en werk de beschadigde rand af.',
      'Herstel vóór oplevering',
    ],
  },
  {
    name: 'Badkamer',
    image: 'bathroom',
    code: 'KIT',
    text: 'Douchebak, wastafel en tegelwerk zijn gefotografeerd. In de douchehoek is de aansluiting plaatselijk onregelmatig en donker verkleurd. Geen oorzaak van eventuele lekkage vastgesteld.',
    outcome: 'unacceptable',
    reason:
      'In dit fictieve scenario heeft de inspecteur een plaatselijke onderbreking in de aansluiting vastgesteld. Kitvoeg controleren en zo nodig vernieuwen.',
    finding: [
      'Aansluiting douchehoek controleren',
      'De aansluiting achter de douchebak is plaatselijk onregelmatig en donker verkleurd. Controleer de hechting en continuïteit van de voeg en herstel de onderbroken aansluiting. Uit dit beeld volgt geen conclusie over verborgen waterdichting.',
      'Natte aansluiting',
    ],
  },
  {
    name: 'Slaapkamer',
    image: 'bedroom',
    code: 'VOCHT',
    text: 'Lege slaapkamer met witte wanden, radiator en lichtgrijze laminaatvloer. De getoonde oppervlakken zijn intact en zonder opvallende vochtverkleuring.',
    outcome: 'acceptable',
    reason: 'Op de getoonde wandvlakken zijn geen zichtbare vochtplekken aanwezig.',
  },
  {
    name: 'Buitenruimte',
    image: 'exterior',
    code: 'VOCHT',
    text: 'Demonstratiefoto van de gemeenschappelijke entree en gevel. De toegang is opgeruimd; normale weersinvloeden op metselwerk en bestrating. Dak en hoge geveldetails vallen buiten deze opname.',
    outcome: 'acceptable',
    reason:
      'Op de getoonde gevelvlakken zijn geen uitgesproken vochtkringen zichtbaar; verborgen en hoger gelegen delen zijn niet beoordeeld.',
  },
];
const question = (label, fields) => ({
  id: uid(label),
  title: '',
  kind: 'text',
  required: true,
  instruction: '',
  talkingPrompt: '',
  ruleId: '',
  elementId: '',
  choices: [],
  unit: '',
  evidence: 'statement',
  minPhotos: 0,
  ...fields,
});
const formats = {};
for (const kind of ['pre', 'final']) {
  const name = `De Sleutels · ${kind === 'pre' ? 'Voorinspectie mutatie' : 'Eindinspectie oplevering'} (demo)`;
  const all = await client.request('GET', `${base}/formats`);
  let doc = all.find((value) => value.name === name);
  if (!doc)
    doc = await client.request('POST', `${base}/formats`, { name, kind, normVersionId: norm.id });
  doc = await client.request('GET', `${base}/formats/${doc.id}`);
  if (doc.status === 'draft') {
    doc.description =
      'Gepubliceerd demonstratieformat voor fictieve Leiden-woningen: overzicht, kwaliteitsbeoordeling en vervolgactie per ruimte. Alle beelden en scenario’s zijn synthetisch.';
    doc.scopes = [
      {
        id: uid(`${kind}:scope:general`),
        name: 'Woning algemeen',
        normRoom: 'Woning algemeen',
        property: true,
        required: true,
        repeatable: false,
        questions: [
          question(`${kind}:general:notes`, {
            title: 'Inspectienotitie en afspraken',
            instruction: 'Leg de context en gemaakte afspraken vast.',
            talkingPrompt: 'Noem het doel van deze inspectie en de afgesproken vervolgacties.',
          }),
          question(`${kind}:general:keys`, {
            title: 'Aantal ontvangen sleutels',
            kind: 'number',
            unit: 'stuks',
            talkingPrompt: 'Noem hoeveel sleutels zijn ontvangen en controleer wat nog ontbreekt.',
          }),
          question(`${kind}:general:ready`, {
            title: kind === 'pre' ? 'Vervolgafspraak besproken?' : 'Woning leeg en bezemschoon?',
            kind: 'boolean',
            talkingPrompt:
              kind === 'pre'
                ? 'Bespreek de herstelpunten vóór de eindinspectie.'
                : 'Controleer de getoonde ruimtes en de opleverafspraken.',
          }),
        ],
      },
      ...roomSpecs.map((spec) => ({
        id: uid(`${kind}:scope:${spec.name}`),
        name: spec.name,
        normRoom: spec.name,
        property: false,
        required: true,
        repeatable: spec.name === 'Slaapkamer',
        questions: [
          question(`${kind}:${spec.name}:overview`, {
            title: `Overzicht en zichtbare staat · ${spec.name}`,
            evidence: 'photo_statement',
            minPhotos: 1,
            instruction: 'Maak een overzichtsfoto en beschrijf alleen de zichtbare staat.',
            talkingPrompt: `Beschrijf de zichtbare afwerking en eventuele aandachtspunten in ${spec.name.toLowerCase()}.`,
          }),
          question(`${kind}:${spec.name}:quality`, {
            title: norm.rules.find((rule) => rule.code === spec.code).title,
            kind: 'quality',
            ruleId: norm.rules.find((rule) => rule.code === spec.code).id,
            evidence: 'photo_statement',
            minPhotos: 1,
            instruction: 'Koppel het oordeel aan de foto en leg beperkingen vast.',
            talkingPrompt: 'Noem het concrete bronbewijs en wat je nog niet kon beoordelen.',
          }),
          question(`${kind}:${spec.name}:action`, {
            title: 'Vervolgactie of aandachtspunt',
            required: false,
            instruction: 'Noteer herstel, controle of geen bijzonderheden.',
            talkingPrompt: 'Benoem wat vóór de volgende afspraak moet gebeuren.',
          }),
        ],
      })),
    ];
    await client.request('PUT', `${base}/formats/${doc.id}`, doc);
    doc = await client.request('GET', `${base}/formats/${doc.id}`);
    await client.request('POST', `${base}/formats/${doc.id}/publish`, { revision: doc.revision });
    doc = await client.request('GET', `${base}/formats/${doc.id}`);
  }
  formats[kind] = doc;
}
console.log('Published formats: pre-inspection and final inspection');

const cases = [
  { home: 0, kind: 'pre', mode: 'review', days: 0, label: 'Beoordelen: keuken en badkamer' },
  {
    home: 1,
    kind: 'final',
    mode: 'ready',
    days: 0,
    label: 'Volledig beoordeeld; klaar om vast te leggen',
  },
  {
    home: 2,
    kind: 'final',
    mode: 'final',
    days: -1,
    label: 'Vastgelegd rapport met foto’s en herstelpunten',
  },
  { home: 3, kind: 'pre', mode: 'planned', days: 1, label: 'Gepland; zelf opnemen' },
  { home: 4, kind: 'pre', mode: 'partial', days: 2, label: 'Deels opgenomen; afronden in de app' },
  {
    home: 5,
    kind: 'pre',
    mode: 'final',
    days: -2,
    label: 'Vastgelegde voorinspectie; benchmarkvoorbeeld',
  },
];
const links = [];
for (const sample of cases) {
  const home = homes[sample.home],
    property = properties.get(home[0]),
    inspectionId = uid(`inspection:${home[0]}`),
    path = `${base}/inspections/${inspectionId}`;
  const existing = (await client.request('GET', `${base}/inspections`)).find(
    (value) => value.id === inspectionId,
  );
  links.push({
    id: inspectionId,
    propertyId: property.id,
    address: property.address,
    kind: sample.kind,
    scenario: sample.label,
    url: `http://localhost:5174/app/inspections/${inspectionId}/${sample.mode === 'final' || sample.mode === 'ready' ? 'report' : sample.mode === 'review' ? 'review' : 'capture'}`,
  });
  if (existing?.status === 'final' || progress.completed.includes(inspectionId)) {
    console.log(`Keeping existing demo: ${property.address}`);
    continue;
  }
  if (!existing) {
    const scheduled = new Date();
    scheduled.setDate(scheduled.getDate() + sample.days);
    scheduled.setHours(sample.home % 2 ? 14 : 10, 30, 0, 0);
    await client.request('POST', `${base}/inspections`, {
      id: inspectionId,
      propertyId: property.id,
      kind: sample.kind,
      formatVersionId: formats[sample.kind].id,
      scheduledAt: scheduled.toISOString(),
    });
  }
  if (sample.mode === 'planned') {
    progress.completed.push(inspectionId);
    await saveProgress();
    console.log(`Planned: ${property.address}`);
    continue;
  }
  let data = await client.request('GET', path);
  const selectedRooms =
    sample.mode === 'partial'
      ? roomSpecs.filter((spec) => ['Entree', 'Keuken', 'Badkamer'].includes(spec.name))
      : roomSpecs;
  for (const spec of selectedRooms) {
    const room = data.rooms.find((value) => value.name === spec.name),
      batchId = uid(`${inspectionId}:batch:${spec.name}`),
      mediaId = uid(`${inspectionId}:photo:${spec.image}`);
    if (!data.batches.some((value) => value.id === batchId))
      await client.request('POST', `${path}/batches`, {
        id: batchId,
        roomId: room.id,
        mediaIds: [mediaId],
        analysisProvider: 'mock',
      });
    if (!data.media.some((value) => value.id === mediaId))
      await client.request(
        'PUT',
        `${path}/batches/${batchId}/media/${mediaId}`,
        images[spec.image],
        { 'Content-Type': 'image/png', 'X-File-Name': `Demo-${spec.image}.png` },
      );
  }
  data = await client.request('GET', path);
  for (const room of data.rooms)
    await client.request('POST', `${path}/rooms/${room.id}/analysis`, {
      action: 'skip',
      reason:
        'Fictief demonstratiescenario: waarnemingen en normantwoorden zijn vooraf handmatig voorbereid; geen betaalde AI-aanroep.',
    });
  data = await client.request('GET', path);
  for (const finding of data.observations.filter(
    (value) => value.source === 'mock' && value.status === 'draft' && value.version === 1,
  )) {
    await client.request('PUT', `${path}/observations/${finding.id}`, {
      title: finding.title,
      description: 'Automatisch voorbeeld vervangen door voorbereide fictieve demowaarneming.',
      label: 'Demo',
      status: 'rejected',
      version: finding.version,
    });
  }
  for (const spec of selectedRooms.filter((value) => value.finding)) {
    const batchId = uid(`${inspectionId}:batch:${spec.name}`),
      findingId = uid(`${inspectionId}:finding:${spec.name}`);
    if (!data.observations.some((value) => value.id === findingId)) {
      await client.request('POST', `${path}/batches/${batchId}/observations`, {
        id: findingId,
        title: spec.finding[0],
        description: spec.finding[1],
        label: spec.finding[2],
        status: ['ready', 'final'].includes(sample.mode) ? 'approved' : 'draft',
      });
    }
  }
  data = await client.request('GET', path);
  for (const answer of data.answers) {
    if (answer.human) continue;
    const room = data.rooms.find((value) => value.id === answer.roomId),
      scope = formats[sample.kind].scopes.find((value) => value.id === room.categoryId),
      q = scope.questions.find((value) => value.id === answer.questionId);
    const spec = roomSpecs.find((value) => value.name === room.name);
    if (spec && !selectedRooms.includes(spec)) continue;
    const photos = spec ? [uid(`${inspectionId}:photo:${spec.image}`)] : [];
    let value,
      reason,
      outcome = '';
    if (!spec) {
      value =
        q.kind === 'number'
          ? 3
          : q.kind === 'boolean'
            ? true
            : `Fictief demoscenario voor ${property.address}. Keuken- en badkamerpunten bespreken; bronidentiteit bevestigd via de democatalogus.`;
      reason = 'Vooraf voorbereide demonstratiewaarde; geen echte bewoners- of contractgegevens.';
    } else if (q.kind === 'quality') {
      value = spec.outcome;
      outcome = spec.outcome;
      reason = spec.reason;
    } else if (q.id === uid(`${sample.kind}:${spec.name}:action`)) {
      value =
        spec.outcome === 'unacceptable'
          ? 'Herstelpunt opnemen en vóór de volgende afspraak controleren.'
          : 'Geen aanvullend herstelpunt voor de getoonde oppervlakken.';
      reason = spec.reason;
    } else {
      value = spec.text;
      reason = 'Voorbereide fictieve waarneming bij de meegeleverde synthetische demonstratiefoto.';
    }
    await client.request('PUT', `${path}/answers/${answer.id}`, {
      value,
      reason,
      outcome,
      photoIds: photos,
      audioIds: [],
      status: 'confirmed',
      version: answer.version,
    });
  }
  data = await client.request('GET', path);
  for (const room of data.rooms)
    await client.request('POST', `${path}/rooms/${room.id}/analysis`, {
      action: 'skip',
      reason:
        'Demo-antwoorden zijn handmatig ingevuld; controle vindt plaats bij de ruimtegoedkeuring.',
    });
  if (['ready', 'final'].includes(sample.mode)) {
    for (const room of data.rooms) {
      const latest = await client.request('GET', path),
        current = latest.rooms.find((value) => value.id === room.id),
        batchIds = new Set(
          latest.batches
            .filter((batch) => batch.roomId === room.id && batch.status !== 'excluded')
            .map((batch) => batch.id),
        );
      await client.request('PUT', `${path}/rooms/${room.id}/approval`, {
        generation: current.generation,
        versions: Object.fromEntries(
          latest.answers
            .filter((answer) => answer.roomId === room.id)
            .map((answer) => [answer.id, answer.version]),
        ),
        observationVersions: Object.fromEntries(
          latest.observations
            .filter((finding) => batchIds.has(finding.batchId))
            .map((finding) => [finding.id, finding.version]),
        ),
        exception: '',
      });
    }
    if (sample.mode === 'final') await client.request('POST', `${path}/report`, {});
  }
  progress.completed.push(inspectionId);
  await saveProgress();
  console.log(`${sample.label}: ${property.address}`);
}

const summary = {
  organization: { id: org.id, name: org.name, slug: org.slug },
  url: 'http://localhost:5174',
  loginEmail: email,
  sourceId,
  normId: norm.id,
  normCount: norm.rules.length,
  formats: Object.fromEntries(
    Object.entries(formats).map(([kind, format]) => [kind, { id: format.id, name: format.name }]),
  ),
  properties: homes.length,
  syntheticImageCount: Object.keys(images).length,
  inspections: links,
};
await writeFile(
  resolve(root, 'demo/sleutels/demo-summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
