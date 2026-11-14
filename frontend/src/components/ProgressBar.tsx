interface Props {
  /** 0–100 */
  value: number;
  tone?: 'brand' | 'water' | 'success';
  label: string;
}

export function ProgressBar({ value, tone = 'brand', label }: Props) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      className={`progress${tone === 'brand' ? '' : ` progress--${tone}`}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 10) / 10}
    >
      <div className="progress__fill" style={{ width: `${v}%` }} />
    </div>
  );
}
