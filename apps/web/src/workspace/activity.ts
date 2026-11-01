import { useEffect, useRef } from 'react';
import { api, json, uuid } from './api';
import { cacheGet, cachePut, cacheKeys, cacheRemove } from './outbox';
import { networkOnline } from './connectivity';

type Activity = {
  id: string;
  inspectionId: string;
  sessionId: string;
  roomId: string | null;
  phase: string;
  startedAt: string;
  endedAt: string;
};
export const activityInterval = (
  from: number,
  to: number,
  lastInput: number,
  capturing: boolean,
) => {
  const finish = capturing ? to : Math.min(to, lastInput + 120000);
  const start = Math.max(from, finish - 30000);
  return finish > start ? { start, finish } : null;
};

export function useActivity({
  base,
  scope,
  inspectionId,
  phase,
  roomId,
  capturing,
  enabled,
}: {
  base: string;
  scope: string;
  inspectionId: string;
  phase: string;
  roomId: string;
  capturing: boolean;
  enabled: boolean;
}) {
  const session = useRef(uuid());
  useEffect(() => {
    if (!enabled || !['capture', 'review', 'report'].includes(phase)) return;
    const prefix = `${scope}:activity:`,
      sessionId = session.current;
    let lastInput = Date.now(),
      lastTick = Date.now(),
      alive = true,
      flushing = false,
      nativeActive = true;
    const input = () => {
      const now = Date.now();
      if (now - lastInput > 120000) lastTick = now;
      lastInput = now;
    };
    const flush = async () => {
      if (flushing || !alive || !networkOnline()) return;
      flushing = true;
      try {
        const keys = (await cacheKeys(prefix)).slice(0, 128);
        const entries = await Promise.all(keys.map((key) => cacheGet<Activity>(key)));
        const now = Date.now();
        const valid = entries.filter(
          (event): event is Activity =>
            !!event &&
            Date.parse(event.startedAt) >= now - 31 * 86400000 &&
            Date.parse(event.endedAt) <= now + 300000,
        );
        for (let index = 0; index < entries.length; index++)
          if (entries[index] && !valid.includes(entries[index]!)) await cacheRemove(keys[index]);
        if (!valid.length) return;
        const controller = new AbortController(),
          timeout = setTimeout(() => controller.abort(), 20000);
        try {
          await api(`${base}/activity-events`, {
            ...json('POST', { events: valid }),
            signal: controller.signal,
          });
          for (const event of valid) await cacheRemove(prefix + event.id);
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        /* Telemetry stays queued and never blocks inspection work. */
      } finally {
        flushing = false;
      }
    };
    const tick = (ending = false) => {
      const now = Date.now(),
        interval = activityInterval(lastTick, now, lastInput, capturing);
      lastTick = now;
      if (
        !nativeActive ||
        (document.hidden && !ending) ||
        !interval ||
        (phase === 'capture' && !capturing)
      )
        return;
      const event: Activity = {
        id: uuid(),
        inspectionId,
        sessionId,
        roomId: roomId || null,
        phase,
        startedAt: new Date(interval.start).toISOString(),
        endedAt: new Date(interval.finish).toISOString(),
      };
      void cachePut(prefix + event.id, event)
        .then(() => flush())
        .catch(() => {});
    };
    const visibility = () => {
      if (document.hidden) tick(true);
      lastTick = Date.now();
      if (!document.hidden) {
        lastInput = Date.now();
        void flush();
      }
    };
    const nativeState = (event: Event) => {
      const active = (event as CustomEvent<{ active: boolean }>).detail.active;
      if (!active) tick(true);
      nativeActive = active;
      lastTick = Date.now();
      if (active) {
        lastInput = Date.now();
        void flush();
      }
    };
    window.addEventListener('satvey-app-state', nativeState);
    const timer = setInterval(() => tick(), 15000),
      retry = setInterval(() => void flush(), 30000);
    for (const type of ['pointerdown', 'keydown', 'input'])
      document.addEventListener(type, input, { passive: true });
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', flush);
    void flush();
    return () => {
      tick(true);
      alive = false;
      clearInterval(timer);
      clearInterval(retry);
      window.removeEventListener('satvey-app-state', nativeState);
      for (const type of ['pointerdown', 'keydown', 'input'])
        document.removeEventListener(type, input);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', flush);
    };
  }, [base, scope, inspectionId, phase, roomId, capturing, enabled]);
}
