import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = process.env.VITE_API_URL;
const url = origin && new URL(origin);
if (!url || url.protocol !== 'https:' || url.origin !== origin || url.username || url.password)
  throw new Error('Set VITE_API_URL to the HTTPS API origin, without a trailing slash.');
if (url.hostname.endsWith('.invalid') && process.env.MOBILE_VERIFY_ONLY !== '1')
  throw new Error('Placeholder origins are allowed only with MOBILE_VERIFY_ONLY=1.');
for (const [script, args] of [
  ['typescript/bin/tsc', ['-b']],
  ['vite/bin/vite.js', ['build']],
  ['@capacitor/cli/bin/capacitor', ['sync']],
]) {
  const result = spawnSync(process.execPath, [resolve(root, 'node_modules', script), ...args], {
    cwd: resolve(root, 'apps/web'),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
