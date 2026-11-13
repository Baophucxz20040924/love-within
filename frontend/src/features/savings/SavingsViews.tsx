import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ProgressBar } from '../../components/ProgressBar';
import { Celebration } from '../bucket/Celebration';
import { useCouplePeople } from '../questions/useCouplePeople';
import { formatNetVnd, formatVnd } from '../../lib/format';
import type { PulseSavings, SavingsGoal } from '../../lib/types';

export const savingsStatus = (status: PulseSavings['status']) => status === 'closed' ? 'Đã đóng' : status === 'reached' ? 'Đã đạt mục tiêu' : 'Đang góp';

/** A single ratio, with actual amounts beside it (negative and >100% are not hidden). */
export function SavingsProgress({ goal }: { goal: PulseSavings }) {
  const percent = goal.totalVnd / goal.targetVnd * 100;
  return <div className="savings-progress">
    <p className="savings-progress__amount">{formatVnd(goal.totalVnd)} <span className="text-sm text-muted">/ {formatVnd(goal.targetVnd)}</span></p>
    <ProgressBar value={percent} label={`Tiến độ ${goal.title}`} />
    <p className="text-sm text-muted">{new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(percent)}% · {savingsStatus(goal.status)}</p>
  </div>;
}

export function SavingsMembers({ goal }: { goal: SavingsGoal }) {
  const { myId, partnerId, partnerFullName } = useCouplePeople();
  return <dl className="savings-members">
    {[{ id: myId, name: 'Bạn' }, { id: partnerId, name: partnerFullName }].filter((p) => p.id).map((p) =>
      <div className="savings-members__row" key={p.id}>
        <dt>{p.name}</dt><dd>{formatNetVnd(goal.contributions.find((c) => c.userId === p.id)?.amountVnd ?? 0)}</dd>
      </div>)}
  </dl>;
}

/** Receives the existing Home pulse; intentionally owns no query or interval. */
export function SavingsHomeCard({ goal }: { goal: PulseSavings }) {
  if (goal.status === 'closed') return null;
  return <Link to={`/savings/${goal.id}`} className="card card--link savings-card" aria-label={`Quỹ chung: ${goal.title}`}>
    <p className="text-sm text-muted">Quỹ chung đang ghim</p>
    <p className="card__title">{goal.emoji} {goal.title}</p>
    <SavingsProgress goal={goal} />
  </Link>;
}

const seenInSession = new Set<string>();
/** Persistent user/goal/event dedup; storage failures still dedup within this session. */
export function SavingsCelebration({ goal }: { goal: SavingsGoal }) {
  const { myId } = useCouplePeople();
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (!myId || !goal.reachedAt || goal.status === 'closed') return;
    const key = `lw:savings:reached:${myId}:${goal.id}:${goal.reachedAt}`;
    if (seenInSession.has(key)) return;
    seenInSession.add(key);
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, '1');
    } catch { /* Private browsing: session dedup still applies. */ }
    setCelebrate(true);
  }, [myId, goal.id, goal.reachedAt, goal.status]);
  return celebrate ? <Celebration /> : null;
}
