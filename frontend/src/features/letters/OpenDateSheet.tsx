import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { localDateOf } from '../../lib/format';
import { COUPLE_KEY, coupleApi } from '../couple/api';
import { EVENTS_KEY, eventsApi } from '../events/api';
import { daysLeftText, eventDayText } from '../events/constants';
import { useCouplePeople } from '../questions/useCouplePeople';
import { daysBetween, inOpenRange, openRange, quickPicks } from './openDates';

interface Props {
  open: boolean;
  value: string | null;
  /** Editing a letter whose current date is today or past: that date stays allowed. */
  keepDate?: string | null;
  onClose: () => void;
  onPick: (day: string) => void;
}

/** "Ngày mở thư": quick picks (partner's birthday, next love milestone, anniversary, 14/02, one year) or any day up to 20 years. */
export function OpenDateSheet({ open, value, keepDate, onClose, onPick }: Props) {
  const { partnerId, partnerName, today } = useCouplePeople();
  // Loaded as soon as the composer opens (this sheet is mounted with it), so the picks are ready when the sheet opens.
  const couple = useQuery({ queryKey: COUPLE_KEY, queryFn: coupleApi.get });
  const events = useQuery({ queryKey: EVENTS_KEY, queryFn: eventsApi.list, staleTime: 60_000 });
  const [custom, setCustom] = useState('');

  useEffect(() => {
    if (open) setCustom(value ?? '');
  }, [open, value]);

  const birthday = events.data?.upcoming.find((e) => !e.auto && e.kind === 'birthday' && e.personId === partnerId) ?? null;
  const c = couple.data;
  const picks = quickPicks({
    today,
    partnerName,
    partnerBirthday: birthday?.date ?? null,
    nextMilestone: c?.nextMilestone ?? null,
    anniversaryDay: c?.anniversaryDate ? localDateOf(c.anniversaryDate, c.timezone) : null,
  });
  const { min, max } = openRange(today);
  const valid = (d: string) => inOpenRange(d, today) || (keepDate !== null && keepDate !== undefined && d === keepDate);
  const when = (d: string) => `${eventDayText(d)} · ${daysLeftText(daysBetween(today, d))}`;

  function pick(d: string) {
    onPick(d);
    onClose();
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Ngày mở thư">
      <div className="form">
        <p className="text-muted">
          {partnerName} mở được thư từ 00:00 ngày này (giờ của hai bạn). Trước đó {partnerName} chỉ thấy phong bì.
        </p>
        <div className="list" role="radiogroup" aria-label="Gợi ý ngày mở">
          {picks.map((p) => (
            <button
              key={p.key}
              type="button"
              role="radio"
              aria-checked={value === p.date}
              className={`list__item letter-pick${value === p.date ? ' is-active' : ''}`}
              onClick={() => pick(p.date)}
            >
              <span className="list__body">
                <span className="list__label">{p.label}</span>
                <span className="list__meta" style={{ display: 'block' }}>
                  {when(p.date)}
                </span>
              </span>
              {value === p.date && <Icon name="check" className="text-brand" />}
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field__label">Hoặc chọn ngày</span>
          <input className="input" type="date" value={custom} min={min} max={max} onChange={(e) => setCustom(e.target.value)} />
          <span className="field__hint">Từ ngày mai tới tối đa 20 năm nữa.</span>
        </label>
        <button type="button" className="btn btn-primary btn-block" disabled={!valid(custom)} onClick={() => pick(custom)}>
          {valid(custom) ? `Mở vào ${eventDayText(custom)}` : 'Chọn một ngày'}
        </button>
      </div>
    </BottomSheet>
  );
}
