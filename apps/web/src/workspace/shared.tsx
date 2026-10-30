import type { ReactNode } from 'react';
import s from './workspace.module.css';

export const errorText = (e: unknown) =>
  e instanceof Error ? e.message : 'Er ging iets mis. Probeer opnieuw.';

export const kindLabel = (kind: string) => (kind === 'pre' ? 'Voorinspectie' : 'Eindinspectie');

export const dateLabel = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('nl-NL', {
        day: 'numeric',

        month: 'short',

        hour: '2-digit',

        minute: '2-digit',
      })
    : 'Niet ingepland';

export const announceRefresh = () => window.dispatchEvent(new Event('satvey-refresh'));

export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <p className={s.error} role="alert">
      {children}
    </p>
  );
}

export function Loading() {
  return (
    <p className={s.loading} role="status">
      Laden…
    </p>
  );
}

export function Select({
  label,

  value,

  onChange,

  children,
}: {
  label: string;

  value: string;

  onChange: (s: string) => void;

  children: ReactNode;
}) {
  return (
    <label className={s.field}>
      <span>{label}</span>

      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}
