import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { ApiRequestError } from '../../lib/apiClient';
import { timeAgo } from '../../lib/format';
import type { Mood, MoodView } from '../../lib/types';
import { MOODS, moodOf } from '../stories/constants';
import { MAX_MOOD_NOTE, applyMyMood, moodsApi } from './api';

/**
 * Hero (CP5): today's mood of my partner ("Hà: 😴 mệt mỏi · 2 giờ trước", tap = their note) and mine (tap = picker),
 * one row each in the Hero's "today" panel.
 */
export function HeroMoods({ mine, partner, partnerName }: { mine: MoodView | null; partner: MoodView | null; partnerName: string }) {
  const [pickOpen, setPickOpen] = useState(false);
  const [partnerOpen, setPartnerOpen] = useState(false);
  const my = moodOf(mine?.mood ?? null);
  const their = moodOf(partner?.mood ?? null);

  return (
    <>
      {partner && their ? (
        <button
          type="button"
          className="hero-row hero-row--partner"
          onClick={() => setPartnerOpen(true)}
          aria-label={`${partnerName}: ${their.label} · ${timeAgo(partner.updatedAt)}${partner.note ? '. Có ghi chú, chạm để xem' : ''}`}
        >
          <span className="hero-row__emoji" aria-hidden="true">
            {their.emoji}
          </span>
          <span className="hero-row__text" aria-hidden="true">
            <strong>{partnerName}:</strong> {their.label} <span className="hero-row__meta">· {timeAgo(partner.updatedAt)}</span>
          </span>
          {partner.note && <Icon name="messageCircle" size={18} className="hero-row__icon" />}
        </button>
      ) : (
        <p className="hero-row hero-row--partner hero-row--empty">
          <span className="hero-row__emoji" aria-hidden="true">
            <Icon name="smile" size={20} />
          </span>
          <span className="hero-row__text">{partnerName} chưa chọn cảm xúc</span>
        </p>
      )}
      <button
        type="button"
        className="hero-row hero-row--mine"
        onClick={() => setPickOpen(true)}
        aria-label={my ? `Cảm xúc hôm nay của bạn: ${my.label}. Chạm để đổi` : 'Chọn cảm xúc hôm nay của bạn'}
      >
        <span className="hero-row__emoji" aria-hidden="true">
          {my ? my.emoji : <Icon name="smile" size={20} />}
        </span>
        <span className="hero-row__text" aria-hidden="true">
          <strong>Bạn:</strong> {my ? my.label : 'hôm nay thế nào?'}
        </span>
        <span className="hero-row__action" aria-hidden="true">
          {my ? 'Đổi' : 'Chọn'}
        </span>
      </button>

      <MoodPickerSheet open={pickOpen} onClose={() => setPickOpen(false)} current={mine} partnerName={partnerName} />
      {partner && <PartnerMoodSheet open={partnerOpen} onClose={() => setPartnerOpen(false)} mood={partner} partnerName={partnerName} />}
    </>
  );
}

/** "Hôm nay bạn thấy thế nào?": one mood of the story list + a short note (≤ 140). Saving again replaces it. */
export function MoodPickerSheet({
  open,
  onClose,
  current,
  partnerName,
}: {
  open: boolean;
  onClose: () => void;
  current: MoodView | null;
  partnerName: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mood, setMood] = useState<Mood | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setMood(current?.mood ?? null);
    setNote(current?.note ?? '');
  }, [open, current?.mood, current?.note]);

  const save = useMutation({
    mutationFn: () => moodsApi.setToday(mood!, note.trim()),
    onSuccess: async (saved) => {
      toast.success('Đã lưu cảm xúc hôm nay');
      onClose();
      await applyMyMood(qc, saved);
    },
    onError: (err) => toast.error(err instanceof ApiRequestError ? err.message : 'Chưa lưu được, thử lại nhé.'),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mood) save.mutate();
  }

  const unchanged = current !== null && current.mood === mood && current.note === note.trim();

  return (
    <BottomSheet open={open} onClose={onClose} title="Hôm nay bạn thấy thế nào?">
      <form className="form" onSubmit={onSubmit}>
        <div className="mood-grid" role="radiogroup" aria-label="Cảm xúc hôm nay">
          {MOODS.map((m) => (
            <button
              key={m.key}
              type="button"
              role="radio"
              aria-checked={mood === m.key}
              className={`mood-opt${mood === m.key ? ' is-active' : ''}`}
              onClick={() => setMood(m.key)}
            >
              <span className="mood-opt__emoji" aria-hidden="true">
                {m.emoji}
              </span>
              <span>{m.label}</span>
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field__label">Ghi chú (không bắt buộc)</span>
          <textarea
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={MAX_MOOD_NOTE}
            rows={2}
            placeholder="VD: Họp cả ngày, tối gọi nhé"
          />
          <span className="char-count">
            {note.length}/{MAX_MOOD_NOTE}
          </span>
        </label>
        <p className="field__hint">{partnerName} sẽ thấy cảm xúc và ghi chú này. Mỗi ngày một cảm xúc, đổi lúc nào cũng được.</p>
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={!mood || unchanged || save.isPending}>
          {save.isPending ? <span className="spinner" aria-hidden="true" /> : null}
          Lưu
        </button>
      </form>
    </BottomSheet>
  );
}

/** My partner's mood of today with the note. */
function PartnerMoodSheet({ open, onClose, mood, partnerName }: { open: boolean; onClose: () => void; mood: MoodView; partnerName: string }) {
  const m = moodOf(mood.mood);
  return (
    <BottomSheet open={open} onClose={onClose} title={`${partnerName} hôm nay`}>
      <div className="stack mood-peek">
        <p className="mood-peek__head">
          <span className="mood-peek__emoji" aria-hidden="true">
            {m?.emoji}
          </span>
          <span>
            <strong>{m?.label}</strong>
            <span className="text-sm text-muted" style={{ display: 'block' }}>
              Cập nhật {timeAgo(mood.updatedAt)}
            </span>
          </span>
        </p>
        {mood.note ? <p className="mood-peek__note">“{mood.note}”</p> : <p className="text-sm text-muted">Không có ghi chú.</p>}
        <Link to="/profile/moods" className="btn btn-secondary btn-block" onClick={onClose}>
          Xem cảm xúc 30 ngày
        </Link>
      </div>
    </BottomSheet>
  );
}
