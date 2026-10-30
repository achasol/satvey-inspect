// Dedicated isolated/staging account only. The full scenario creates inspection fixtures.
import { performance } from 'node:perf_hooks';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
const base = process.env.LOAD_BASE_URL?.replace(/\/$/, '');
if (!base || process.env.ALLOW_LOAD_TEST !== '1')
  throw new Error('Set LOAD_BASE_URL and ALLOW_LOAD_TEST=1 for an isolated/staging deployment');
const users = Number(process.env.LOAD_CONCURRENCY || 25),
  seconds = Number(process.env.LOAD_DURATION_SECONDS || 1800);
if (
  !Number.isInteger(users) ||
  users < 1 ||
  users > 100 ||
  !Number.isFinite(seconds) ||
  seconds < 1 ||
  seconds > 86400
)
  throw new Error('Invalid load concurrency/duration');
const full = process.env.LOAD_MODE !== 'read';
const email = process.env.LOAD_EMAIL,
  password = process.env.LOAD_PASSWORD;
if (!email || !password) throw new Error('Dedicated LOAD_EMAIL and LOAD_PASSWORD are required');
const response = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Satvey-Request': '1' },
  body: JSON.stringify({ email, password }),
  signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error(`Login failed (${response.status})`);
const cookie = response.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('No session cookie');
const headers = { Cookie: cookie, 'X-Satvey-Request': '1' };
const timings = { api: [], upload: [], pdf: [] };
let errors = 0;
async function call(path, method = 'GET', body, kind = 'api', extra = {}) {
  const start = performance.now();
  try {
    const binary = Buffer.isBuffer(body);
    const result = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        ...headers,
        ...(body && !binary ? { 'Content-Type': 'application/json' } : {}),
        ...extra,
      },
      body: body ? (binary ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(kind === 'pdf' ? 180000 : 30000),
    });
    const data = Buffer.from(await result.arrayBuffer());
    if (!result.ok)
      throw new Error(`${method} ${path.replace(/[a-f0-9-]{36}/g, ':id')}: HTTP ${result.status}`);
    return result.headers.get('content-type')?.includes('json')
      ? JSON.parse(data.toString())
      : data;
  } catch (error) {
    errors++;
    throw error;
  } finally {
    timings[kind].push(performance.now() - start);
  }
}
const account = await call('/me');
const org = process.env.LOAD_ORG_ID || account.organisations[0]?.id;
if (!org) throw new Error('No organisation');
headers['X-Satvey-User'] = account.user.id;
const root = `/orgs/${org}`;
let photo, property, format, reportId, reportBefore;
if (full) {
  if (!process.env.LOAD_PHOTO)
    throw new Error(
      'Full capacity validation requires a representative local LOAD_PHOTO (JPEG or PNG)',
    );
  photo = readFileSync(process.env.LOAD_PHOTO);
  property =
    process.env.LOAD_PROPERTY_ID ||
    (await call(`${root}/properties`)).items.find((p) => p.linkState === 'linked')?.id;
  format =
    process.env.LOAD_FORMAT_ID ||
    (await call(`${root}/formats`)).find((f) => f.status === 'published')?.id;
  reportId =
    process.env.LOAD_REPORT_ID ||
    (await call(`${root}/inspections?limit=100`)).find((i) => i.status === 'final')?.id;
  if (!property || !format || !reportId)
    throw new Error(
      'Supply a linked LOAD_PROPERTY_ID, published LOAD_FORMAT_ID and frozen LOAD_REPORT_ID',
    );
  reportBefore = await call(`${root}/inspections/${reportId}/report`);
  if ((reportBefore.media || []).length < 30)
    throw new Error('The reference PDF report must contain at least 30 source photos');
}
const dossiers = full
  ? await Promise.all(
      Array.from({ length: users }, async () => {
        const id = randomUUID();
        await call(`${root}/inspections`, 'POST', {
          id,
          propertyId: property,
          formatVersionId: format,
          kind: 'pre',
        });
        const data = await call(`${root}/inspections/${id}`);
        return {
          id,
          roomId:
            data.rooms.find((r) =>
              data.format?.scopes?.some((s) => s.id === r.categoryId && !s.property),
            )?.id || data.rooms[0].id,
          media: [],
        };
      }),
    )
  : [];
// Exclude fixture provisioning and verification from the measured workload.
for (const samples of Object.values(timings)) samples.length = 0;
const end = performance.now() + seconds * 1000;
await Promise.all(
  Array.from({ length: users }, async (_, index) => {
    let nextUpload = performance.now() + index * 500,
      nextPDF = performance.now() + index * 2400;
    while (performance.now() < end) {
      try {
        await call(`${root}/inspections?limit=50`);
        if (full) {
          const dossier = dossiers[index];
          await call(`${root}/inspections/${dossier.id}`);
          if (performance.now() >= nextUpload) {
            const batch = randomUUID(),
              media = randomUUID(),
              path = `${root}/inspections/${dossier.id}/batches`;
            await call(path, 'POST', {
              id: batch,
              roomId: dossier.roomId,
              mediaIds: [media],
              ...(process.env.LOAD_LIVE_AI === '1' ? {} : { analysisProvider: 'mock' }),
            });
            const mime = photo[0] === 0xff ? 'image/jpeg' : 'image/png';
            for (let attempt = 0; attempt < 2; attempt++)
              await call(`${path}/${batch}/media/${media}`, 'PUT', photo, 'upload', {
                'Content-Type': mime,
                'X-File-Name': `load-${media}.${mime === 'image/jpeg' ? 'jpg' : 'png'}`,
              });
            dossier.media.push(media);
            nextUpload = performance.now() + 20000;
          }
          if (performance.now() >= nextPDF) {
            const pdf = await call(`${root}/inspections/${reportId}/report/pdf`, 'POST', {}, 'pdf');
            if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invalid PDF');
            nextPDF = performance.now() + 60000;
          }
        }
      } catch (error) {
        console.error(error.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }),
);
const measured = structuredClone(timings);
let integrity = full,
  queuedJobs = 0;
if (full) {
  const digest = createHash('sha256').update(photo).digest('hex');
  for (const dossier of dossiers) {
    const data = await call(`${root}/inspections/${dossier.id}`);
    queuedJobs += (data.jobs || []).filter(
      (j) => j.status === 'pending' || j.status === 'processing',
    ).length;
    for (const id of dossier.media) {
      if (data.media.filter((m) => m.id === id).length !== 1) {
        integrity = false;
        continue;
      }
      const bytes = await call(`${root}/media/${id}`);
      if (createHash('sha256').update(bytes).digest('hex') !== digest) integrity = false;
    }
  }
  if (
    JSON.stringify(await call(`${root}/inspections/${reportId}/report`)) !==
    JSON.stringify(reportBefore)
  )
    integrity = false;
}
const percentile = (values) => {
  values.sort((a, b) => a - b);
  return values.length
    ? values[Math.min(values.length - 1, Math.floor(values.length * 0.95))]
    : null;
};
const apiP95 = percentile(measured.api),
  pdfP95 = percentile(measured.pdf);
const summary = {
  mode: full ? 'capture-api-pdf' : 'read',
  concurrency: users,
  durationSeconds: seconds,
  requests: Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, v.length])),
  errors,
  apiP95Milliseconds: apiP95,
  pdfP95Milliseconds: pdfP95,
  uploadP95Milliseconds: percentile(measured.upload),
  photoBytes: photo?.length || 0,
  evidenceIntegrity: integrity,
  queuedJobs,
  passed:
    errors === 0 &&
    apiP95 !== null &&
    apiP95 < 500 &&
    (!full || (integrity && pdfP95 !== null && pdfP95 < 60000)),
  referenceRun: full && users === 25 && seconds >= 1800,
};
mkdirSync('tests/artifacts', { recursive: true });
writeFileSync('tests/artifacts/load.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
if (!summary.passed) process.exitCode = 1;
