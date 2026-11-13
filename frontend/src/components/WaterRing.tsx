import { formatNumber } from '../lib/format';

interface Props {
  totalMl: number;
  /** Submitted but not yet approved by the partner — drawn as a lighter arc after the total. */
  pendingMl?: number;
  goalMl: number | null;
  size?: number;
  stroke?: number;
  /** Hide the text in the middle (small ring next to other text). */
  compact?: boolean;
}

/** Circular water progress: solid = approved, light = waiting for the partner. */
export function WaterRing({ totalMl, pendingMl = 0, goalMl, size = 196, stroke = 16, compact = false }: Props) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const goal = goalMl && goalMl > 0 ? goalMl : 0;
  const approved = goal ? Math.min(1, totalMl / goal) : 0;
  const pending = goal ? Math.min(1 - approved, pendingMl / goal) : 0;
  const c = size / 2;

  const label = goal
    ? `Đã uống ${totalMl} trên ${goal} ml${pendingMl ? `, ${pendingMl} ml đang chờ xác nhận` : ''}`
    : `Đã uống ${totalMl} ml`;

  return (
    <div className={`ring${compact ? ' ring--sm' : ''}`} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--water-100)" strokeWidth={stroke} />
        {pending > 0 && (
          <circle
            className="ring__arc"
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke="var(--water-200)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circ * (approved + pending)} ${circ}`}
            transform={`rotate(-90 ${c} ${c})`}
          />
        )}
        {approved > 0 && (
          <circle
            className="ring__arc"
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke="var(--water-600)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circ * approved} ${circ}`}
            transform={`rotate(-90 ${c} ${c})`}
          />
        )}
      </svg>
      {!compact && (
        <div className="ring__center">
          <span className="ring__value">{formatNumber(totalMl)}</span>
          <span className="ring__sub">{goal ? `/ ${formatNumber(goal)} ml` : 'ml hôm nay'}</span>
        </div>
      )}
      {compact && (
        <div className="ring__center">
          <span className="ring__value">{goal ? `${Math.round(approved * 100)}%` : '—'}</span>
        </div>
      )}
    </div>
  );
}
