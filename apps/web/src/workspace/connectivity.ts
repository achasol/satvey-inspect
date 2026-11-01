import { nativeDevice } from './nativeStorage';

let connected: boolean | undefined;
export const networkOnline = () =>
  nativeDevice ? (connected ?? navigator.onLine) : navigator.onLine;
export async function initializeConnectivity() {
  if (!nativeDevice) return;
  const { Network } = await import('@capacitor/network');
  const update = (value: { connected: boolean }) => {
    const previous = connected;
    connected = value.connected;
    if (previous !== connected) window.dispatchEvent(new Event(connected ? 'online' : 'offline'));
  };
  update(await Network.getStatus());
  await Network.addListener('networkStatusChange', update);
}
