import { networkOnline, initializeConnectivity } from './connectivity';
import {
  nativeDevice,
  nativeSetting,
  restoreNativeDatabase,
  setNativeSetting,
  collectNativeGarbage,
} from './nativeStorage';
type Session = { token: string; expiresAt: string; userId: string };
let session: Session | undefined;
const resourceURLs = new Map<string, string>();
export function apiURL(path: string) {
  if (!nativeDevice) return path;
  const origin = String(import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
  if (!/^https:\/\/[^/]+$/.test(origin))
    throw new Error('Configureer een geldige HTTPS VITE_API_URL voor de mobiele app.');
  return origin + path;
}
export async function platformFetch(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (nativeDevice && session) headers.set('Authorization', `Bearer ${session.token}`);
  return fetch(apiURL(path), {
    ...options,
    headers,
    credentials: nativeDevice ? 'omit' : options.credentials || 'same-origin',
  });
}
export async function rememberSession(value?: Session) {
  if (session?.token !== value?.token) {
    for (const url of resourceURLs.values()) URL.revokeObjectURL(url);
    resourceURLs.clear();
  }
  session = value;
  await setNativeSetting('session', value);
  if (!value) {
    for (const url of resourceURLs.values()) URL.revokeObjectURL(url);
    resourceURLs.clear();
  }
}
export function protectedURL(path: string) {
  return nativeDevice ? resourceURLs.get(path) || '' : path;
}
export async function loadProtectedResource(path: string, force = false) {
  if (!nativeDevice) return path;
  if (!path.startsWith('/api/v1/orgs/')) throw new Error('Ongeldige bronverwijzing');
  if (resourceURLs.has(path) && !force) return resourceURLs.get(path)!;
  const key = `resource:${path}`;
  let file: { bytes: ArrayBuffer; mime: string } | undefined;
  if (networkOnline()) {
    try {
      const response = await platformFetch(path);
      if ([401, 403, 404, 410].includes(response.status)) {
        if (response.status === 401) window.dispatchEvent(new Event('satvey-auth-expired'));
        await removeProtectedResource(path);
        await collectNativeGarbage();
        throw new Error('Bronbewijs is niet toegankelijk');
      }
      if (!response.ok) throw new TypeError('Bronbewijs tijdelijk niet beschikbaar');
      file = {
        bytes: await response.arrayBuffer(),
        mime: response.headers.get('content-type') || 'application/octet-stream',
      };
      await setNativeSetting(key, file);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  file ??= await nativeSetting(key);
  if (!file) throw new Error('Bronbewijs is niet op dit apparaat beschikbaar');
  const url = URL.createObjectURL(new Blob([file.bytes], { type: file.mime }));
  const previous = resourceURLs.get(path);
  if (previous) URL.revokeObjectURL(previous);
  resourceURLs.set(path, url);
  return url;
}
export async function prepareResponseResources(value: unknown, path: string) {
  if (!nativeDevice || !value || typeof value !== 'object') return;
  const organisations = (value as { organisations?: { id: string; logoAssetId?: string | null }[] })
    .organisations;
  for (const organisation of organisations || [])
    if (organisation.logoAssetId)
      await loadProtectedResource(
        `/api/v1/orgs/${organisation.id}/norm-assets/${organisation.logoAssetId}`,
      );
  const org = path.match(/^\/orgs\/([^/]+)/)?.[1];
  if (!org) return;
  const data = value as {
    organisation?: { logoAssetId?: string };
    media?: { id: string; contentDeletedAt?: string | null }[];
    norms?: {
      rules?: {
        examples?: { assetId?: string }[];
        scoreLevels?: { references?: { assetId?: string }[] }[];
      }[];
    };
    rules?: {
      examples?: { assetId?: string }[];
      scoreLevels?: { references?: { assetId?: string }[] }[];
    }[];
  };
  if (data.organisation?.logoAssetId)
    await loadProtectedResource(`/api/v1/orgs/${org}/norm-assets/${data.organisation.logoAssetId}`);
  let retired = false;
  for (const media of data.media || []) {
    const resource = `/api/v1/orgs/${org}/media/${media.id}`;
    if (media.contentDeletedAt) {
      if (resourceURLs.has(resource) || (await nativeSetting(`resource:${resource}`))) {
        await removeProtectedResource(resource);
        retired = true;
      }
    } else await loadProtectedResource(resource);
  }
  if (retired) await collectNativeGarbage();
  for (const rule of data.norms?.rules || data.rules || [])
    for (const example of [
      ...(rule.examples || []),
      ...(rule.scoreLevels || []).flatMap(
        (level: { references?: { assetId?: string }[] }) => level.references || [],
      ),
    ])
      if (example.assetId)
        await loadProtectedResource(`/api/v1/orgs/${org}/norm-assets/${example.assetId}`);
}
export async function startMobileLogin() {
  const { Browser } = await import('@capacitor/browser');
  const random = () =>
    [...crypto.getRandomValues(new Uint8Array(32))]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
  const verifier = random(),
    state = random();
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...digest))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  await setNativeSetting('login', { verifier, state });
  const response = await platformFetch('/api/v1/auth/mobile/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Satvey-Request': '1' },
    body: JSON.stringify({ challenge, state }),
  });
  if (!response.ok) throw new Error('Appaanmelding kon niet worden gestart');
  const result = (await response.json()) as { url: string };
  await Browser.open({ url: result.url });
}
async function mobileCallback(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'nl.satvey.inspect:' || url.host !== 'auth' || url.pathname !== '/callback')
    return;
  const pending = await nativeSetting<{ state: string; verifier: string }>('login');
  if (!pending || url.searchParams.get('state') !== pending.state) return;
  await setNativeSetting('login', undefined);
  const response = await platformFetch('/api/v1/auth/mobile/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Satvey-Request': '1' },
    body: JSON.stringify({ code: url.searchParams.get('code'), verifier: pending.verifier }),
  });
  if (!response.ok) throw new Error('Aanmelding verlopen. Meld je opnieuw aan.');
  await rememberSession((await response.json()) as Session);
  const { Browser } = await import('@capacitor/browser');
  await Browser.close().catch(() => {});
  window.dispatchEvent(new Event('satvey-auth-changed'));
}
export async function initializePlatform() {
  if (!nativeDevice) return;
  await initializeConnectivity();
  await restoreNativeDatabase();
  const pendingCapture = await nativeSetting('pending-camera-result');
  if (pendingCapture) await (await import('./nativeCapture')).restoreNativeCapture(pendingCapture);
  session = await nativeSetting<Session>('session');
  if (session && Date.parse(session.expiresAt) <= Date.now()) await rememberSession(undefined);
  const { App } = await import('@capacitor/app');
  const handle = (url: string) => {
    void mobileCallback(url).catch((error) =>
      window.dispatchEvent(
        new CustomEvent('satvey-platform-error', {
          detail: error instanceof Error ? error.message : 'Appaanmelding mislukt',
        }),
      ),
    );
  };
  await App.addListener('appUrlOpen', (event) => handle(event.url));
  const launch = await App.getLaunchUrl();
  if (launch?.url) await mobileCallback(launch.url);
  await App.addListener('appRestoredResult', (event) => {
    if (event.pluginId === 'Camera' && event.success) {
      void import('./nativeCapture')
        .then((module) => module.restoreNativeCapture(event.data))
        .catch((error) =>
          window.dispatchEvent(new CustomEvent('satvey-platform-error', { detail: String(error) })),
        );
    }
  });
  await App.addListener('appStateChange', (event) => {
    window.dispatchEvent(
      new CustomEvent('satvey-app-state', { detail: { active: event.isActive } }),
    );
    if (event.isActive) {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('satvey-refresh'));
      window.dispatchEvent(new Event('satvey-access-check'));
    }
  });
}
export async function savePlatformFile(blob: Blob, filename: string) {
  if (nativeDevice) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem'),
      { Share } = await import('@capacitor/share');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let raw = '';
    for (let i = 0; i < bytes.length; i += 8192)
      raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const file = await Filesystem.writeFile({
      path: `exports/${crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '-')}`,
      directory: Directory.Cache,
      data: btoa(raw),
      recursive: true,
    });
    await Share.share({ url: file.uri, title: filename });
    return;
  }
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function removeProtectedResource(path: string) {
  const url = resourceURLs.get(path);
  if (url) URL.revokeObjectURL(url);
  resourceURLs.delete(path);
  await setNativeSetting(`resource:${path}`, undefined);
}
