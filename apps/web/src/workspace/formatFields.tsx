import type { ReactNode } from 'react';
import type { FormatQuestion } from './types';
import s from './workspace.module.css';
export const evidenceLabels: Record<FormatQuestion['evidence'], string> = {
  none: 'Geen aparte onderbouwing',
  photo: 'Foto',
  statement: 'Gesproken of geschreven waarneming',
  photo_statement: 'Foto en waarneming',
  any: 'Foto, audio of geschreven waarneming',
};
export const questionLabels: Record<FormatQuestion['kind'], string> = {
  boolean: 'Ja / nee',
  choice: 'Keuze',
  number: 'Getal',
  text: 'Korte beschrijving',
  quality: 'Kwaliteitsbeoordeling',
  evidence: 'Onderbouwing met beschrijving',
};
export function FormatSelect({
  label,
  value,
  onChange,
  children,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={s.field}>
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </label>
  );
}
