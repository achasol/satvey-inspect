import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import s from './workspace.module.css';

export function useMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const change = () => setMobile(query.matches);
    change();
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return mobile;
}

export function ResponsiveTabs({
  label,
  value,
  items,
}: {
  label: string;
  value: string;
  items: { id: string; label: string; href: string; mobileHidden?: boolean }[];
}) {
  const mobile = useMobile(),
    navigate = useNavigate();
  const visible = items.filter((item) => !mobile || !item.mobileHidden);
  if (mobile)
    return (
      <label className={s.field}>
        <span>{label}</span>
        <select
          aria-label={label}
          value={visible.some((item) => item.id === value) ? value : visible[0]?.id}
          onChange={(event) => {
            const item = visible.find((item) => item.id === event.target.value);
            if (item) navigate(item.href);
          }}
        >
          {visible.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <nav className={s.stages} aria-label={label}>
      {visible.map((item) => (
        <Link
          key={item.id}
          to={item.href}
          className={item.id === value ? s.activeStage : ''}
          aria-current={item.id === value ? 'page' : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
