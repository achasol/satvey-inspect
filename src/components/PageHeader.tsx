import s from '../pages/pages.module.css';

export function PageHeader({
  category,
  title,
  description,
}: {
  category: string;
  title: string;
  description: string;
}) {
  return (
    <div className={s.pageHeader}>
      <div className={s.eyebrow}>
        <span className={s.smallDot} />
        {category.toUpperCase()}
      </div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
