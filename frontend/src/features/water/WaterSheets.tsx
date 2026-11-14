import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { PROPOSAL_KEY } from '../proposals/api';
import { ApiRequestError } from '../../lib/apiClient';
import { formatMl, formatNumber, shortName } from '../../lib/format';
import { pushSuggest } from '../push/suggest';
import { WATER_KEY, WATER_PENDING_KEY, waterApi } from './api';

function usePartnerName(): string {
  const { me } = useAuth();
  const partner = me?.couple?.members.find((m) => m.id !== me.user.id);
  return partner ? shortName(partner.displayName) : 'người ấy';
}

const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');

interface SheetProps {
  open: boolean;
  onClose: () => void;
}

const ML_PICKS = [150, 250, 350, 500];

/** Manual entry (fallback when AI fails). Also needs the partner's approval. */
export function ManualWaterSheet({ open, onClose }: SheetProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const partnerName = usePartnerName();
  const [ml, setMl] = useState('250');

  useEffect(() => {
    if (open) setMl('250');
  }, [open]);

  const submit = useMutation({
    mutationFn: () => waterApi.manual(Number(ml)),
    onSuccess: async (r) => {
      toast.success(`Đã gửi ${formatMl(r.amountMl)} cho ${partnerName} xác nhận`);
      pushSuggest.trigger('couple');
      onClose();
      await Promise.all([
        qc.invalidateQueries({ queryKey: WATER_KEY }),
        qc.invalidateQueries({ queryKey: WATER_PENDING_KEY }),
      ]);
    },
  });

  useEffect(() => {
    if (open && submit.isError) submit.reset();
  }, [open, submit.reset]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submit.mutate();
  }

  const value = Number(ml);
  const valid = Number.isInteger(value) && value >= 10 && value <= 3000;

  return (
    <BottomSheet open={open} onClose={onClose} title="Nhập lượng nước">
      <form className="form" onSubmit={onSubmit}>
        <div className="quick-picks" role="group" aria-label="Chọn nhanh">
          {ML_PICKS.map((v) => (
            <button
              key={v}
              type="button"
              className={`quick-pick${value === v ? ' is-active' : ''}`}
              onClick={() => setMl(String(v))}
            >
              {formatNumber(v)} ml
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field__label">Số ml</span>
          <div className="input-wrap">
            <input
              className="input num"
              type="number"
              inputMode="numeric"
              min={10}
              max={3000}
              value={ml}
              onChange={(e) => setMl(e.target.value)}
              required
            />
            <span className="input-suffix">ml</span>
          </div>
          <span className="field__hint">Từ 10 đến 3.000 ml. {partnerName} sẽ xác nhận trước khi được cộng.</span>
        </label>
        {submit.isError && <p className="form-feedback" role="alert">{errorText(submit.error)}</p>}
        <button type="submit" className="btn btn-water btn-lg btn-block" disabled={!valid || submit.isPending}>
          {submit.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="check" size={18} />}
          Gửi để {partnerName} xác nhận
        </button>
      </form>
    </BottomSheet>
  );
}

const GOAL_PICKS = [1500, 2000, 2500, 3000];

/** Propose a daily water goal — applied only when both agree. */
export function WaterGoalSheet({ open, onClose, currentGoal }: SheetProps & { currentGoal: number | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const partnerName = usePartnerName();
  const [goal, setGoal] = useState(String(currentGoal ?? 2000));

  useEffect(() => {
    if (open) setGoal(String(currentGoal ?? 2000));
  }, [open, currentGoal]);

  const propose = useMutation({
    mutationFn: () => waterApi.proposeGoal(Number(goal)),
    onSuccess: async () => {
      toast.success(`Đã gửi đề xuất. Chờ ${partnerName} đồng ý.`);
      onClose();
      await Promise.all([
        qc.invalidateQueries({ queryKey: PROPOSAL_KEY }),
        qc.invalidateQueries({ queryKey: WATER_KEY }),
      ]);
    },
  });

  useEffect(() => {
    if (open && propose.isError) propose.reset();
  }, [open, propose.reset]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    propose.mutate();
  }

  const value = Number(goal);
  const valid = Number.isInteger(value) && value >= 250 && value <= 6000;

  return (
    <BottomSheet open={open} onClose={onClose} title="Mục tiêu nước mỗi ngày">
      <form className="form" onSubmit={onSubmit}>
        <p className="text-muted">Mục tiêu áp dụng cho mỗi người, mỗi ngày. Cần cả hai cùng đồng ý.</p>
        <div className="quick-picks" role="group" aria-label="Chọn nhanh">
          {GOAL_PICKS.map((v) => (
            <button
              key={v}
              type="button"
              className={`quick-pick${value === v ? ' is-active' : ''}`}
              onClick={() => setGoal(String(v))}
            >
              {formatNumber(v)} ml
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field__label">Mục tiêu</span>
          <div className="input-wrap">
            <input
              className="input num"
              type="number"
              inputMode="numeric"
              min={250}
              max={6000}
              step={50}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              required
            />
            <span className="input-suffix">ml</span>
          </div>
          <span className="field__hint">Từ 250 đến 6.000 ml.</span>
        </label>
        {propose.isError && <p className="form-feedback" role="alert">{errorText(propose.error)}</p>}
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={!valid || propose.isPending}>
          Gửi đề xuất cho {partnerName}
        </button>
      </form>
    </BottomSheet>
  );
}
