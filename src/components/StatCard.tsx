interface StatCardProps {
  label: string;
  value: string | number;
  emphasis?: 'default' | 'alert';
}

export function StatCard({
  label,
  value,
  emphasis = 'default'
}: StatCardProps) {
  return (
    <div className={`stat-card stat-card--${emphasis}`}>
      <span className="stat-card__label">{label}</span>
      <strong className="stat-card__value">{value}</strong>
    </div>
  );
}
