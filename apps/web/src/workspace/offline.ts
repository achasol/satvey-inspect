import { api } from './api';
import type { Account, Dossier } from './types';
import { actions, cachePut, pendingDraftCount, removeInspectionCache } from './outbox';
import {
  nativeDevice,
  nativeSetting,
  setNativeSetting,
  collectNativeGarbage,
} from './nativeStorage';
import {
  loadProtectedResource,
  prepareResponseResources,
  removeProtectedResource,
} from './platform';

export type PreparedVisit = {
  id: string;
  address: string;
  path: string;
  preparedAt: string;
  expiresAt: string;
  bytes: number;
};
type Authorization = { userId: string; orgId: string; authorizedAt: string; expiresAt: string };
export async function rememberAccount(account: Account) {
  if (nativeDevice) await setNativeSetting('account', account);
}
export async function offlineAccount(): Promise<Account | undefined> {
  if (!nativeDevice) return;
  const session = await nativeSetting<{ userId: string; expiresAt: string }>('session');
  if (!session || Date.parse(session.expiresAt) <= Date.now()) return;
  const account = await nativeSetting<Account>('account');
  if (!account || session.userId !== account.user.id) return;
  const previousClock = (await nativeSetting<number>('last-clock')) || 0;
  if (Date.now() < previousClock - 60000)
    throw new Error('De apparaatklok is gewijzigd. Maak verbinding om toegang te vernieuwen.');
  const organisations = [];
  for (const org of account.organisations) {
    const grant = await nativeSetting<Authorization>(`grant:${account.user.id}:${org.id}`);
    if (
      grant &&
      grant.userId === account.user.id &&
      grant.orgId === org.id &&
      Date.parse(grant.expiresAt) > Date.now()
    )
      organisations.push(org);
  }
  if (!organisations.length)
    throw new Error(
      'Offline toegang verlopen of nog niet voorbereid. Maak verbinding; je lokale werk blijft bewaard.',
    );
  await setNativeSetting('last-clock', Date.now());
  return { ...account, organisations };
}
export async function preparedVisits(scope: string) {
  return (await nativeSetting<PreparedVisit[]>(`prepared:${scope}`)) || [];
}
export async function prepareVisit(
  scope: string,
  path: string,
  onProgress: (text: string) => void,
) {
  if (!nativeDevice)
    throw new Error('Voorbereid offline werken is beschikbaar in de iOS- en Android-app.');
  const [user, org] = scope.split(':');
  onProgress('Dossier en bronbewijs downloaden…');
  const data = await api<Dossier>(path);
  await prepareResponseResources(data, path);
  // Refresh every source explicitly before declaring preparation successful.
  let bytes = 0;
  const media = data.media.filter((m) => !m.contentDeletedAt);
  for (let i = 0; i < media.length; i++) {
    onProgress(`Bronbewijs ${i + 1} van ${data.media.length} downloaden…`);
    await loadProtectedResource(`/api/v1/orgs/${org}/media/${media[i].id}`, true);
    const file = await nativeSetting<{ bytes: ArrayBuffer }>(
      `resource:/api/v1/orgs/${org}/media/${media[i].id}`,
    );
    bytes += file?.bytes.byteLength || 0;
  }
  const grant = await api<Authorization>(`/orgs/${org}/offline-grant`);
  if (grant.userId !== user || grant.orgId !== org)
    throw new Error('Het account is gewijzigd; bereid het dossier opnieuw voor.');
  await cachePut(`${scope}:${path}`, data);
  const item: PreparedVisit = {
    id: data.inspection.id,
    address: data.inspection.address,
    path,
    preparedAt: new Date().toISOString(),
    expiresAt: grant.expiresAt,
    bytes,
  };
  const list = await preparedVisits(scope);
  await setNativeSetting(`prepared:${scope}`, [...list.filter((i) => i.id !== item.id), item]);
  await setNativeSetting(`grant:${scope}`, grant);
  await setNativeSetting('last-clock', Date.now());
  onProgress('Dossier klaar voor offline gebruik.');
  return item;
}
export async function removePreparedVisit(scope: string, item: PreparedVisit) {
  const data = await api<Dossier>(item.path).catch(() => undefined);
  if (!data)
    throw new Error(
      'Maak verbinding om te controleren of alle wijzigingen veilig zijn opgeslagen.',
    );
  if (
    (await actions(scope)).some((a) => a.inspectionId === item.id) ||
    (await pendingDraftCount(
      scope,
      item.id,
      data.observations.map((o) => o.id),
    ))
  )
    throw new Error('Bewaar en synchroniseer eerst de lokale wijzigingen.');
  // Media IDs have one dossier owner; shared framework assets remain cached.
  await removeInspectionCache(scope, item.path);
  const org = scope.split(':')[1];
  for (const media of data.media)
    await removeProtectedResource(`/api/v1/orgs/${org}/media/${media.id}`);
  await setNativeSetting(
    `prepared:${scope}`,
    (await preparedVisits(scope)).filter((i) => i.id !== item.id),
  );
  await collectNativeGarbage();
}
