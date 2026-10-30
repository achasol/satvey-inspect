import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { cacheGet, cachePut } from './outbox';

export function useResource<T>(scope: string, path: string) {
  const [data, setData] = useState<T>(),
    [error, setError] = useState(''),
    [cached, setCached] = useState(false);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    setData(undefined);
  }, [scope, path]);
  useEffect(() => {
    let alive = true;
    setError('');
    setCached(false);
    const update = async () => {
      try {
        const value = await api<T>(path);
        if (!alive) return;
        setData(value);
        setError('');
        setCached(false);
        await cachePut(`${scope}:${path}`, value).catch(() => {});
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : 'Laden mislukt');
        if (e instanceof ApiError) setData(undefined);
        if (!(e instanceof ApiError)) {
          const value = await cacheGet<T>(`${scope}:${path}`).catch(() => undefined);
          if (alive && value) {
            setData(value);
            setCached(true);
          }
        }
      }
    };
    void update();
    const refresh = () => {
      void update();
    };
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener('satvey-refresh', refresh);
    window.addEventListener('online', refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('satvey-refresh', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [scope, path, revision]);
  return { data, error, cached, reload };
}
