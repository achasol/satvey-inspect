import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { cacheGet, cachePut } from './outbox';
import { prepareResponseResources } from './platform';

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
    let sequence = 0;
    let controller: AbortController | undefined;
    setError('');
    setCached(false);
    const update = async () => {
      const current = ++sequence;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      const valid = () => alive && current === sequence && !signal.aborted;
      try {
        const value = await api<T>(path, {
          signal,
          headers: { 'X-Satvey-User': scope.split(':')[0] },
        });
        if (!valid()) return;
        setData(value);
        setError('');
        setCached(false);
        await cachePut(`${scope}:${path}`, value).catch(() => {});
      } catch (e) {
        if (!valid()) return;
        setError(e instanceof Error ? e.message : 'Laden mislukt');
        if (e instanceof ApiError) setData(undefined);
        if (!(e instanceof ApiError)) {
          const value = await cacheGet<T>(`${scope}:${path}`).catch(() => undefined);
          if (valid() && value !== undefined) {
            try {
              await prepareResponseResources(value, path);
            } catch (resourceError) {
              if (valid()) {
                setData(undefined);
                setCached(false);
                setError(
                  resourceError instanceof Error
                    ? resourceError.message
                    : 'Lokale bronnen zijn niet beschikbaar',
                );
              }
              return;
            }
            if (!valid()) return;
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
      controller?.abort();
      clearInterval(timer);
      window.removeEventListener('satvey-refresh', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [scope, path, revision]);
  return { data, error, cached, reload };
}
