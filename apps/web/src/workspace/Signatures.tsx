import { useRef } from 'react';
import type { PointerEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Field } from '../components/ui';
import type { PhotoPoint, ReportSignature, SignatureInput } from './api';
import s from './workspace.module.css';

export const signatureRoles = {
  inspector: 'Inspecteur',
  resident: 'Bewoner',
  other: 'Overige aanwezige',
};

function pathFor(strokes: PhotoPoint[][]) {
  return strokes
    .map((stroke) => stroke.map((p, i) => `${i ? 'L' : 'M'}${p.x * 600} ${p.y * 180}`).join(' '))
    .join(' ');
}

function SignaturePad({
  value,
  onChange,
  label,
  disabled,
}: {
  value: PhotoPoint[][];
  onChange: (value: PhotoPoint[][]) => void;
  label: string;
  disabled: boolean;
}) {
  const drawing = useRef<{ pointer: number; strokes: PhotoPoint[][] } | null>(null);
  const point = (e: PointerEvent<SVGSVGElement>) => {
    const bounds = e.currentTarget.getBoundingClientRect();
    return {
      x: +Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width)).toFixed(4),
      y: +Math.max(0, Math.min(1, (e.clientY - bounds.top) / bounds.height)).toFixed(4),
    };
  };
  const finish = () => {
    if (!drawing.current) return;
    onChange(drawing.current.strokes.filter((stroke) => stroke.length >= 2));
    drawing.current = null;
  };
  return (
    <div>
      <svg
        className={s.signaturePad}
        viewBox="0 0 600 180"
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (!disabled && ['Delete', 'Backspace'].includes(e.key)) {
            e.preventDefault();
            onChange([]);
          }
        }}
        onPointerDown={(e) => {
          if (disabled || !e.isPrimary || e.button !== 0 || value.length >= 100) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = { pointer: e.pointerId, strokes: [...value, [point(e)]] };
          onChange(drawing.current.strokes);
        }}
        onPointerMove={(e) => {
          const active = drawing.current;
          if (!active || active.pointer !== e.pointerId) return;
          if (active.strokes.reduce((n, stroke) => n + stroke.length, 0) >= 3000) return;
          const last = active.strokes[active.strokes.length - 1];
          active.strokes = [...active.strokes.slice(0, -1), [...last, point(e)]];
          onChange(active.strokes);
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
      >
        <path
          d={pathFor(value)}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className={s.actions}>
        <small className={s.muted}>Teken met muis, pen of vinger.</small>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || !value.length}
          onClick={() => onChange([])}
        >
          Handtekening wissen
        </Button>
      </div>
    </div>
  );
}

export function SignaturesEditor({
  value,
  onChange,
  disabled,
}: {
  value: SignatureInput[];
  onChange: (value: SignatureInput[]) => void;
  disabled: boolean;
}) {
  const patch = (index: number, fields: Partial<SignatureInput>) =>
    onChange(value.map((signature, i) => (i === index ? { ...signature, ...fields } : signature)));
  return (
    <section className={s.stack} aria-label="Handtekeningen verzamelen">
      <div>
        <h3>Handtekeningen (optioneel)</h3>
        <p className={s.muted}>Laat de inspecteur, bewoner of een andere aanwezige tekenen.</p>
      </div>
      {value.map((signature, index) => (
        <fieldset key={index} className={`${s.panel} ${s.stack}`}>
          <legend>Ondertekenaar {index + 1}</legend>
          <Field
            label="Naam ondertekenaar"
            value={signature.name}
            maxLength={120}
            disabled={disabled}
            onChange={(e) => patch(index, { name: e.target.value })}
          />
          <label className={s.field}>
            <span>Rol ondertekenaar</span>
            <select
              aria-label="Rol ondertekenaar"
              value={signature.role}
              disabled={disabled}
              onChange={(e) => patch(index, { role: e.target.value as SignatureInput['role'] })}
            >
              {Object.entries(signatureRoles).map(([role, label]) => (
                <option key={role} value={role}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <SignaturePad
            value={signature.strokes}
            disabled={disabled}
            onChange={(strokes) => patch(index, { strokes })}
            label={`Handtekening ondertekenaar ${index + 1}`}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={15} />}
            disabled={disabled}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            Ondertekenaar verwijderen
          </Button>
        </fieldset>
      ))}
      <Button
        variant="secondary"
        icon={<Plus size={16} />}
        disabled={disabled || value.length >= 10}
        onClick={() =>
          onChange([
            ...value,
            {
              name: '',
              role: value.some((v) => v.role === 'inspector') ? 'resident' : 'inspector',
              strokes: [],
            },
          ])
        }
      >
        Ondertekenaar toevoegen
      </Button>
    </section>
  );
}

export function ReportSignatures({ signatures }: { signatures: ReportSignature[] }) {
  if (!signatures.length) return null;
  return (
    <section className={s.stack} aria-label="Vastgelegde handtekeningen">
      <h3>Handtekeningen</h3>
      {signatures.map((signature, index) => (
        <div key={index} className={s.signatureCard}>
          <strong>{signature.name}</strong>
          <p>{signatureRoles[signature.role]}</p>
          <svg
            className={s.signatureImage}
            viewBox="0 0 600 180"
            role="img"
            aria-label={`Handtekening van ${signature.name}`}
          >
            <path
              d={pathFor(signature.strokes)}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <small className={s.muted}>
            Vastgelegd op {new Date(signature.signedAt).toLocaleString('nl-NL')}
          </small>
        </div>
      ))}
    </section>
  );
}
