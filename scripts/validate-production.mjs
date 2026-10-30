import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const values = parseEnv(
  readFileSync(process.argv[2] || new URL('../.env.production', import.meta.url), 'utf8'),
);
for (const name of [
  'WEB_IMAGE',
  'API_IMAGE',
  'CADDY_IMAGE',
  'POSTGRES_IMAGE',
  'RUSTFS_IMAGE',
  'PDF_IMAGE',
]) {
  if (!/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(values[name] || ''))
    throw new Error(`${name} must be a verified repository@sha256:digest reference`);
}
const origin = new URL(values.APP_URL);
if (origin.protocol !== 'https:' || origin.hostname !== values.APP_DOMAIN)
  throw new Error('APP_URL and APP_DOMAIN must identify the same HTTPS origin');
if (origin.port && origin.port !== '443')
  throw new Error('The bundled HTTPS deployment serves port 443');
const password = new URL(values.DATABASE_URL).password;
if (decodeURIComponent(password) !== values.POSTGRES_PASSWORD)
  throw new Error('DATABASE_URL password must match POSTGRES_PASSWORD');
console.log('Production image references and public origin validated.');
