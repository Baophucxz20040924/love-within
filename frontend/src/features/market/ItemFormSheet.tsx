import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { FormError, useFormDismiss } from '../../components/useFormDismiss';
import { useToast } from '../../components/Toast';
import { ApiRequestError } from '../../lib/apiClient';
import type { MarketItem } from '../../lib/types';
import { MARKET_KEY, marketApi } from './api';

const EMOJIS = ['🎁', '💆', '🍽️', '🎬', '☕', '🧹', '🛏️', '💌', '🎮', '🌹'];
const PRICE_PICKS = [10, 20, 50, 100];

interface Props {
  open: boolean;
  onClose: () => void;
  /** null = post a new item in MY shop. */
  editing: MarketItem | null;
}

/** Post or edit a reward in my shop (something I will do for my partner). */
export function ItemFormSheet({ open, onClose, editing }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [emoji, setEmoji] = useState('🎁');
  const [price, setPrice] = useState('20');
  const [initialDraft, setInitialDraft] = useState('');

  useEffect(() => {
    if (!open) return;
    setTitle(editing?.title ?? '');
    setDescription(editing?.description ?? '');
    setEmoji(editing?.emoji ?? '🎁');
    setPrice(String(editing?.priceCoin ?? 20));
    setInitialDraft(JSON.stringify([editing?.title ?? '', editing?.description ?? '', editing?.emoji ?? '🎁', String(editing?.priceCoin ?? 20)]));
  }, [open, editing?.id]);

  const save = useMutation({
    mutationFn: () => {
      const input = { title: title.trim(), description: description.trim(), emoji, priceCoin: Number(price) };
      return editing ? marketApi.update(editing.id, input) : marketApi.create(input);
    },
    onSuccess: async () => {
      toast.success(editing ? 'Đã cập nhật món' : 'Đã đăng vào gian hàng của bạn 🎁');
      onClose();
      await qc.invalidateQueries({ queryKey: MARKET_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.'),
  });

  useEffect(() => { save.reset(); }, [open, editing?.id]);

  const { requestClose, discardPrompt } = useFormDismiss({
    open,
    dirty: JSON.stringify([title, description, emoji, price]) !== initialDraft,
    busy: save.isPending,
    onClose,
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid || save.isPending) return;
    save.mutate();
  }

  const priceValue = Number(price);
  const valid = title.trim().length > 0 && Number.isInteger(priceValue) && priceValue >= 1;

  return (
    <BottomSheet open={open} busy={save.isPending} onClose={requestClose} title={editing ? 'Sửa món' : 'Đăng món vào gian hàng'}>
      {discardPrompt}
      <form className="form" onSubmit={onSubmit}>
        <fieldset className="form" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} disabled={save.isPending}>
        {!editing && <p className="text-sm text-muted">Món bạn đăng là phần thưởng bạn sẽ thực hiện khi người ấy đổi bằng Xu.</p>}
        <div className="emoji-grid" role="radiogroup" aria-label="Biểu tượng">
          {EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              role="radio"
              aria-checked={emoji === e}
              aria-label={e}
              className={`emoji-pick${emoji === e ? ' is-active' : ''}`}
              onClick={() => setEmoji(e)}
            >
              {e}
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field__label">Tên món</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="VD: Massage vai 15 phút" required />
        </label>
        <label className="field">
          <span className="field__label">Mô tả (tuỳ chọn)</span>
          <textarea className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="Điều kiện, thời hạn…" />
        </label>
        <div className="field">
          <span className="field__label">Giá</span>
          <div className="quick-picks" role="group" aria-label="Chọn nhanh giá">
            {PRICE_PICKS.map((v) => (
              <button key={v} type="button" className={`quick-pick${priceValue === v ? ' is-active' : ''}`} onClick={() => setPrice(String(v))}>
                {v} Xu
              </button>
            ))}
          </div>
          <div className="input-wrap">
            <input className="input num" type="number" inputMode="numeric" min={1} value={price} onChange={(e) => setPrice(e.target.value)} aria-label="Giá (Xu)" required />
            <span className="input-suffix">Xu</span>
          </div>
        </div>
        <FormError error={save.error} />
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={!valid || save.isPending}>
          {save.isPending && <span className="spinner" aria-hidden="true" />}
          {editing ? 'Lưu thay đổi' : 'Đăng món'}
        </button>
        </fieldset>
      </form>
    </BottomSheet>
  );
}
