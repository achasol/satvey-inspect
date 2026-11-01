// Connect only the fictional, explicitly named local demo to the test double.
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { randomUUID } from 'node:crypto';

const apiBase = process.env.DEMO_API_URL || 'http://127.0.0.1:8088/api/v1';
const parsed = new URL(apiBase);
if (!['localhost', '127.0.0.1'].includes(parsed.hostname))
  throw new Error('The VERA demo setup only accepts a loopback app URL');
const certificate = readFileSync(new URL('../.cache/vera-receiver-ca.pem', import.meta.url));
let cookie = '';
async function app(path, method = 'GET', body) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: { Cookie: cookie, 'X-Satvey-Request': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
  });
  if (path === '/auth/login')
    cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  if (!response.ok) throw new Error(`Local demo API ${path} returned HTTP ${response.status}`);
  return response.json();
}
function control(path, method, body) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      `https://localhost:8090/_test/${path}`,
      {
        method,
        ca: certificate,
        timeout: 15_000,
        headers: {
          'X-Test-Control-Key': 'dummy-control-secret-only-for-tests',
          'Content-Type': 'application/json',
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300)
            return reject(new Error(`Dummy control ${path} returned HTTP ${response.statusCode}`));
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Dummy control timed out')));
    req.on('error', reject);
    req.end(raw);
  });
}
await app('/auth/login', 'POST', { email: 'demo@desleutels.local', password: 'SleutelsDemo2026!' });
const account = await app('/me');
const org = account.organisations.find((item) => item.slug === 'desleutels-demo');
if (!org) throw new Error('The fictional De Sleutels demo organisation is required');
const base = `/orgs/${org.id}`;
let settings = await app(`${base}/handover-destinations`);
const name = 'VERA testontvanger (lokaal)';
let destination = settings.destinations.find((item) => item.name === name);
if (!destination) {
  destination = await app(`${base}/handover-destinations`, 'PUT', {
    id: randomUUID(),
    name,
    enabled: true,
    revision: 0,
    onderhoudUrl: 'https://vera-receiver:8090/onderhoud/v4',
    dossierUrl: 'https://vera-receiver:8090/dossier/v4',
    vastgoedUrl: 'https://vera-receiver:8090/vastgoed/v4',
    tokenUrl: 'https://vera-receiver:8090/oauth/token',
    clientId: 'satvey-test',
    secret: 'dummy-client-secret-only-for-tests',
    scopes: '',
    organisation: org.id,
    administration: 'SATVEY-DEMO',
    reportTypeCode: '',
    maintenanceTypeCode: '',
  });
}
if (!destination.enabled)
  throw new Error('The existing demo destination is disabled; enable it explicitly in settings');
if (destination.vastgoedUrl !== 'https://vera-receiver:8090/vastgoed/v4')
  throw new Error('The existing destination does not identify this local dummy');
const state = await control('state', 'GET');
const units = new Set(state.records['/vastgoed/v4/eenheden'].map((item) => item.id));
let mapped = 0;
for (let page = 1; ; page++) {
  const properties = await app(`${base}/properties?state=linked&page=${page}`);
  for (const property of properties.items) {
    const unit = `demo-${property.id}`;
    if (!units.has(unit)) {
      await control('seed', 'POST', {
        resource: '/vastgoed/v4/eenheden',
        record: { id: unit, code: property.objectNumber || unit },
      });
      units.add(unit);
    }
    if (
      settings.mappings.some(
        (item) => item.destinationId === destination.id && item.propertyId === property.id,
      )
    )
      continue;
    await app(`${base}/handover-destinations/${destination.id}/properties`, 'PUT', {
      propertyId: property.id,
      unitUri: `https://vera-receiver:8090/vastgoed/v4/eenheden/${unit}`,
    });
    mapped++;
  }
  if (page * properties.pageSize >= properties.total || !properties.items.length) break;
}
console.log(
  `Local VERA test receiver ready for De Sleutels Demo; ${mapped} new property mappings. No handovers were approved or sent.`,
);
