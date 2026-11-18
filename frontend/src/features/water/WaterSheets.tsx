import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { PROPOSAL_KEY } from '../proposals/api';
import { ApiRequestError, assertCurrentSession, currentAccessEpoch } from '../../lib/apiClient';
import { tokenStore } from '../../lib/tokenStore';
import { formatMl, formatNumber, shortName } from '../../lib/format';
import { pushSuggest } from '../push/suggest';
import { WATER_KEY, WATER_PENDING_KEY, waterApi, prepareWaterProof, uploadWaterProof } from './api';

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

/** Manual ml with optional private evidence. This flow never invokes AI. */
export function ManualWaterSheet({ open, onClose }: SheetProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const partnerName = usePartnerName();
  const [ml, setMl] = useState('250');
  const [file, setFile] = useState<File | null>(null);
  const [proof, setProof] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const lifecycle = useRef(0);
  const preparation = useRef<AbortController | null>(null);
  const uploaded = useRef<{ blob: Blob; key: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  function clearProof() {
    preparation.current?.abort();
    preparation.current = null;
    setFile(null); setProof(null); setPhotoError(null); setPreparing(false);
    uploaded.current = null; // Never delete an object: an unclear POST may already reference it.
  }

  useEffect(() => {
    lifecycle.current += 1;
    clearProof(); setProgress(null);
    if (open) { setMl('250'); setUncertain(false); }
    return () => { lifecycle.current += 1; preparation.current?.abort(); };
  }, [open]);

  useEffect(() => {
    if (!proof) { setPreview(null); return; }
    const url = URL.createObjectURL(proof);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [proof]);

  async function selectProof(selected: File) {
    clearProof();
    setFile(selected); setPreparing(true);
    const controller = new AbortController();
    preparation.current = controller;
    try {
      const blob = await prepareWaterProof(selected, controller.signal);
      if (!controller.signal.aborted) setProof(blob);
    } catch (err) {
      if (!controller.signal.aborted) setPhotoError(err instanceof Error ? err.message : 'Không xử lý được ảnh.');
    } finally {
      if (!controller.signal.aborted) setPreparing(false);
    }
  }

  const submit = useMutation({
    mutationFn: async () => {
      const version = lifecycle.current;
      const generation = tokenStore.generation();
      const epoch = currentAccessEpoch();
      const active = () => {
        assertCurrentSession(generation);
        if (version !== lifecycle.current || epoch !== currentAccessEpoch()) throw new Error('Màn hình đã thay đổi.');
      };
      let sent = false;
      try {
        active();
        let key: string | undefined;
        if (proof) {
          if (uploaded.current?.blob === proof) key = uploaded.current.key;
          else {
            setProgress('Đang xin quyền tải ảnh…');
            key = await uploadWaterProof(proof, percent => setProgress(`Đang tải minh chứng… ${percent}%`), active);
            uploaded.current = { blob: proof, key };
          }
        }
        active();
        setProgress('Đang gửi lượng nước…');
        sent = true;
        const result = await waterApi.manual(Number(ml), key);
        active();
        return { result, active };
      } catch (err) {
        try {
          active();
          // No automatic repost after a possible commit. The user must check their pending logs.
          if (sent && (!(err instanceof ApiRequestError) || err.status >= 500)) setUncertain(true);
        } catch { /* obsolete view */ }
        throw err;
      } finally {
        try { active(); setProgress(null); } catch { /* obsolete view */ }
      }
    },
    onSuccess: ({ result, active }) => {
      try { active(); } catch { return; }
      toast.success(`Đã gửi ${formatMl(result.amountMl)} cho ${partnerName} xác nhận`);
      pushSuggest.trigger('couple');
      onClose();
      void Promise.all([
        qc.invalidateQueries({ queryKey: WATER_KEY }),
        qc.invalidateQueries({ queryKey: WATER_PENDING_KEY }),
      ]).catch(() => undefined);
    },
  });

  useEffect(() => {
    if (open) submit.reset();
  }, [open, submit.reset]);

  const value = Number(ml);
  const valid = Number.isInteger(value) && value >= 10 && value <= 3000;
  const busy = preparing || submit.isPending;
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (valid && !busy && !uncertain && (!file || proof)) submit.mutate();
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Nhập lượng nước">
      <form className="form" onSubmit={onSubmit}>
        <div className="quick-picks" role="group" aria-label="Chọn nhanh">
          {ML_PICKS.map((v) => (
            <button
              key={v}
              type="button"
              className={`quick-pick${value === v ? ' is-active' : ''}`}
              disabled={submit.isPending || uncertain}
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
              disabled={submit.isPending || uncertain}
              onChange={(e) => setMl(e.target.value)}
              required
            />
            <span className="input-suffix">ml</span>
          </div>
          <span className="field__hint">Từ 10 đến 3.000 ml. {partnerName} sẽ xác nhận trước khi được cộng.</span>
        </label>
        <div className="field">
          <span className="field__label">Ảnh minh chứng (không bắt buộc)</span>
          <p className="field__hint">Nhập ml của bạn; ảnh chỉ để {partnerName} xem và duyệt, không gửi tới AI. Bạn vẫn có thể gửi không ảnh.</p>
          <input ref={input} type="file" accept="image/*" hidden aria-label="Chọn ảnh minh chứng" disabled={busy || uncertain}
            onChange={e => { const selected = e.target.files?.[0]; e.target.value = ''; if (selected) void selectProof(selected); }} />
          {preview && <img src={preview} alt="Ảnh minh chứng đã xử lý" style={{ width: '100%', maxHeight: 240, objectFit: 'contain', borderRadius: 12 }} />}
          <div className="btn-row">
            <button type="button" className="btn btn-outline" disabled={busy || uncertain} onClick={() => input.current?.click()}>
              <Icon name="camera" size={18} /> {file ? 'Chọn lại ảnh' : 'Chọn ảnh minh chứng'}
            </button>
            {file && <button type="button" className="btn btn-ghost" disabled={submit.isPending || uncertain} onClick={clearProof}>Bỏ ảnh</button>}
          </div>
          {preparing && <p role="status">Đang xử lý ảnh và loại bỏ thông tin vị trí…</p>}
          {photoError && <div role="alert"><p className="form-feedback">{photoError}</p>
            <button type="button" className="btn btn-ghost" disabled={busy || uncertain} onClick={() => { if (file) void selectProof(file); }}>Thử xử lý ảnh lại</button>
          </div>}
        </div>
        {progress && <p role="status" aria-live="polite">{progress}</p>}
        {submit.isError && !uncertain && <p className="form-feedback" role="alert">{submit.error instanceof Error ? submit.error.message : errorText(submit.error)}</p>}
        {uncertain && <div role="alert"><p>Chưa xác nhận được kết quả gửi. Kiểm tra lịch sử và mục chờ duyệt trước khi gửi lại để tránh trùng lượt.</p>
          <button type="button" className="btn btn-outline" onClick={() => {
            void Promise.all([qc.invalidateQueries({ queryKey: WATER_KEY }), qc.invalidateQueries({ queryKey: WATER_PENDING_KEY })]).catch(() => undefined);
            onClose();
          }}>Đóng và kiểm tra lượt đã gửi</button>
        </div>}
        <button type="submit" className="btn btn-water btn-lg btn-block" disabled={!valid || busy || uncertain || Boolean(file && !proof)}>
          {submit.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="check" size={18} />}
          {submit.isError && !uncertain ? 'Thử gửi lại' : `Gửi để ${partnerName} xác nhận`}
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
