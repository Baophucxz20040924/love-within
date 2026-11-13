import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { EmptyState, ErrorState, Skeleton } from '../../components/StatusViews';
import { useToast } from '../../components/Toast';
import { useFormDismiss } from '../../components/useFormDismiss';
import { useComposerFeedback } from '../../hooks/useComposerFeedback';
import { ApiRequestError, assertCurrentSession } from '../../lib/apiClient';
import { tokenStore } from '../../lib/tokenStore';
import { formatDay, formatVnd } from '../../lib/format';
import type { BankTxn, SavingsEntryInput, SavingsGoal } from '../../lib/types';
import { useCouplePeople } from '../questions/useCouplePeople';
import { refreshSavings, savingsApi, savingsError, savingsListOptions } from './api';

const MAX_AMOUNT = 10_000_000_000;
const fieldsetStyle = { border: 0, padding: 0, margin: 0, minWidth: 0 };

/** Ignore delayed completions after a sheet unmounts or the login changes. */
function useSheetSession() {
  const [generation] = useState(() => tokenStore.generation());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return { generation, current: () => mounted.current && tokenStore.isCurrent(generation) };
}

/** Mount only while open: errors retain inputs, reopening starts a fresh proposal. */
export function SavingsGoalSheet({ goal, closeGoal = false, onClose }: { goal?: SavingsGoal; closeGoal?: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSheetSession();
  const feedback = useComposerFeedback();
  const [title, setTitle] = useState(goal?.title ?? '');
  const [emoji, setEmoji] = useState(goal?.emoji ?? '💰');
  const [target, setTarget] = useState(goal ? String(goal.targetVnd) : '');
  const [dueOn, setDueOn] = useState(goal?.dueOn ?? '');
  const save = useMutation({
    mutationFn: () => {
      assertCurrentSession(session.generation);
      return goal
        ? savingsApi.proposeUpdate(goal.id, closeGoal ? { close: true } : { targetVnd: Number(target), dueOn: dueOn || null })
        : savingsApi.propose({ title: title.trim(), emoji: emoji.trim(), targetVnd: Number(target), dueOn: dueOn || null });
    },
    onSuccess: () => {
      if (!session.current()) return;
      toast.success('Đã gửi đề xuất, chờ người ấy đồng ý.'); onClose(); void refreshSavings(qc);
    },
    onError: (err) => { if (session.current()) feedback.setError(savingsError(err)); },
    onSettled: () => { feedback.submitting.current = false; },
  });
  const valid = closeGoal || (title.trim() && emoji.trim() && Number.isInteger(Number(target)) && Number(target) >= 100_000 && Number(target) <= MAX_AMOUNT);
  const unchanged = goal && !closeGoal && Number(target) === goal.targetVnd && (dueOn || null) === goal.dueOn;
  const dirty = title !== (goal?.title ?? '') || emoji !== (goal?.emoji ?? '💰') || target !== (goal ? String(goal.targetVnd) : '') || dueOn !== (goal?.dueOn ?? '');
  const dismiss = useFormDismiss({ open: true, dirty, busy: save.isPending || feedback.submitting.current, onClose });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || unchanged || feedback.submitting.current || !session.current()) return;
    feedback.submitting.current = true; feedback.setError(null); save.mutate();
  }
  return <BottomSheet open busy={save.isPending} onClose={dismiss.requestClose} title={closeGoal ? 'Đề xuất đóng quỹ' : goal ? 'Đổi mục tiêu / hạn' : 'Đề xuất quỹ mới'}>
    <form className="form" onSubmit={submit} aria-describedby={feedback.error ? feedback.errorId : undefined}>
      <p className="text-sm text-muted">Cần người ấy đồng ý trong Cần duyệt mới áp dụng. App chỉ ghi lại, không chuyển tiền.</p>
      {closeGoal ? <p>Đóng “{goal?.title}”? Lịch sử vẫn còn, nhưng không thể góp, rút hay xóa khoản nữa.</p> : <fieldset disabled={save.isPending} className="stack" style={fieldsetStyle}>
        {!goal && <>
          <label className="field"><span className="field__label">Tên quỹ</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required /></label>
          <label className="field"><span className="field__label">Biểu tượng</span><input className="input" value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={16} required /></label>
        </>}
        <label className="field"><span className="field__label">Mục tiêu (VND)</span><input className="input" type="number" inputMode="numeric" min={100_000} max={MAX_AMOUNT} step={1} value={target} onChange={(e) => setTarget(e.target.value)} required /><span className="text-sm text-muted">Từ 100.000đ đến 10 tỷ đồng.</span></label>
        <label className="field"><span className="field__label">Hạn (tuỳ chọn)</span><input className="input" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></label>
        {dueOn && <button type="button" className="btn btn-ghost" onClick={() => setDueOn('')}>Bỏ hạn</button>}
      </fieldset>}
      {feedback.error && <p id={feedback.errorId} ref={feedback.errorRef} tabIndex={-1} className="text-sm text-danger" role="alert">{feedback.error}</p>}
      <button type="submit" className="btn btn-primary btn-block" disabled={!valid || Boolean(unchanged) || save.isPending}>{save.isPending ? 'Đang gửi…' : 'Gửi đề xuất'}</button>
    </form>
    {dismiss.discardPrompt}
  </BottomSheet>;
}

export function SavingsEntrySheet({ goal, withdraw, onClose }: { goal: SavingsGoal; withdraw: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSheetSession();
  const feedback = useComposerFeedback();
  const { today } = useCouplePeople();
  const [amount, setAmount] = useState('');
  const [day, setDay] = useState(today);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const attempt = useRef<{ goalId: string; body: SavingsEntryInput; uncertain: boolean } | null>(null);
  const locked = busy || uncertain;
  const valid = goal.status !== 'closed' && Number.isInteger(Number(amount)) && Number(amount) > 0 && Number(amount) <= MAX_AMOUNT && day && day <= today && (!withdraw || note.trim());
  const dismiss = useFormDismiss({ open: true, dirty: !!amount || !!note || day !== today, busy: locked || feedback.submitting.current, onClose });
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (feedback.submitting.current || (!attempt.current && !valid) || !session.current()) return;
    feedback.submitting.current = true; setBusy(true); feedback.setError(null);
    // Retries send this snapshot, never the live form values or a new operation ID.
    if (!attempt.current) attempt.current = { goalId: goal.id, body: { operationId: crypto.randomUUID(), amountVnd: Number(amount) * (withdraw ? -1 : 1), occurredOn: day, note: note.trim() }, uncertain: false };
    const sent = attempt.current;
    try {
      assertCurrentSession(session.generation);
      await savingsApi.addEntry(sent.goalId, sent.body);
      if (!session.current()) return;
      attempt.current = null; setUncertain(false);
      toast.success('Đã xác nhận yêu cầu. Số dư và lịch sử đang được cập nhật.'); onClose(); void refreshSavings(qc);
    } catch (err) {
      if (!session.current()) return;
      const ambiguous = !(err instanceof ApiRequestError) || err.status >= 500 || err.status === 408 || err.code === 'SAVINGS_RECOVERY_REQUIRED';
      // A later busy/rejection cannot prove an earlier uncertain write did not commit.
      sent.uncertain ||= ambiguous;
      setUncertain(sent.uncertain);
      feedback.setError(sent.uncertain
        ? `Chưa rõ khoản này đã được lưu chưa. Giữ nguyên nội dung và thử lại cùng yêu cầu để tránh ghi hai lần. ${savingsError(err)}`
        : savingsError(err));
      if (!sent.uncertain) attempt.current = null;
    } finally {
      feedback.submitting.current = false;
      if (session.current()) setBusy(false);
    }
  }
  return <BottomSheet open busy={locked} title={withdraw ? 'Rút tiền' : 'Góp tiền'} onClose={dismiss.requestClose}>
    <form className="form" onSubmit={(e) => void submit(e)} aria-describedby={feedback.error ? feedback.errorId : undefined}>
      <p className="text-sm text-muted">{goal.title} · Chỉ ghi lại, không chuyển tiền. Người ấy thấy khoản này.</p>
      <fieldset disabled={locked} className="stack" style={fieldsetStyle}>
        <label className="field"><span className="field__label">Số tiền (VND)</span><input className="input" type="number" inputMode="numeric" min={1} max={MAX_AMOUNT} step={1} required value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="field"><span className="field__label">Ngày</span><input className="input" type="date" max={today} required value={day} onChange={(e) => setDay(e.target.value)} /></label>
        <label className="field"><span className="field__label">Ghi chú</span><textarea className="input" maxLength={200} required={withdraw} value={note} onChange={(e) => setNote(e.target.value)} /><span className="text-sm text-muted">{withdraw ? 'Khoản rút bắt buộc có lý do. ' : ''}{note.length}/200</span></label>
      </fieldset>
      {feedback.error && <p id={feedback.errorId} ref={feedback.errorRef} tabIndex={-1} className="text-sm text-danger" role="alert">{feedback.error}</p>}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || (!uncertain && !valid)}>{busy ? 'Đang lưu…' : uncertain ? 'Thử lại cùng yêu cầu' : withdraw ? 'Lưu khoản rút' : 'Lưu khoản góp'}</button>
    </form>
    {dismiss.discardPrompt}
  </BottomSheet>;
}

/** Embedded inside the owner NoteSheet, not another modal and never a nested form/button. */
export function BankSavingsAction({ txn, disabled }: { txn: BankTxn; disabled: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSheetSession();
  const feedback = useComposerFeedback();
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState<SavingsGoal | null>(null);
  const [attached, setAttached] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search.trim()), 300); return () => window.clearTimeout(timer); }, [search]);
  const searching = search.trim() !== query;
  const list = useInfiniteQuery({ ...savingsListOptions({ status: 'open', q: query, limit: 20 }), enabled: choosing && txn.isMine && txn.direction === 'out' });
  const goals = [...new Map((list.data?.pages.flatMap((p) => p.items) ?? []).map((g) => [g.id, g])).values()];
  const attach = useMutation({
    mutationFn: (goalId: string) => { assertCurrentSession(session.generation); return savingsApi.attach(txn.id, goalId); },
    onSuccess: () => {
      if (!session.current()) return;
      setAttached(true); setChoosing(false); toast.success('Đã ghi giao dịch vào quỹ'); void refreshSavings(qc);
    },
    onError: (err) => { if (session.current()) feedback.setError(savingsError(err)); },
    onSettled: () => { feedback.submitting.current = false; },
  });
  if (!txn.isMine || txn.direction !== 'out') return null;
  if (attached) return <p className="text-sm" role="status">Đã ghi giao dịch vào quỹ. Ghi chú của bạn không được sao chép.</p>;
  return <section className="stack savings-bank" aria-label="Góp quỹ từ giao dịch">
    {!choosing ? <button type="button" className="btn btn-outline btn-block" disabled={disabled} onClick={() => setChoosing(true)}>Ghi là tiền góp quỹ…</button> : <>
      <label className="field"><span className="field__label">Tìm quỹ đang mở</span><input type="search" className="input" value={search} maxLength={120} disabled={attach.isPending || disabled} onChange={(e) => setSearch(e.target.value)} /></label>
      {searching && <p className="text-sm text-muted" role="status">Đang chờ tìm kiếm, kết quả bên dưới chưa cập nhật.</p>}
      {list.isLoading && <Skeleton height={64} />}
      {list.isError && !list.isFetchNextPageError && <ErrorState onRetry={() => void list.refetch()} />}
      {list.data && <>
        {goals.length === 0 ? <EmptyState title={query ? 'Không tìm thấy quỹ phù hợp' : 'Chưa có quỹ đang mở'} hint={query ? 'Thử tên khác hoặc bỏ tìm kiếm.' : 'Tạo quỹ và chờ người ấy đồng ý trước khi góp.'} action={!query ? <Link className="btn btn-outline" to="/savings">Xem Quỹ chung</Link> : undefined} /> : <label className="field"><span className="field__label">Chọn quỹ</span><select className="input" aria-label="Chọn quỹ" value={selected?.id ?? ''} onChange={(e) => setSelected(goals.find((g) => g.id === e.target.value) ?? null)} disabled={attach.isPending || disabled || searching}><option value="">Chọn một quỹ</option>{selected && !goals.some((g) => g.id === selected.id) && <option value={selected.id}>{selected.emoji} {selected.title} (đã chọn)</option>}{goals.map((g) => <option key={g.id} value={g.id}>{g.emoji} {g.title}</option>)}</select></label>}
        {selected && <p className="text-sm" role="status">Quỹ đã chọn: {selected.emoji} {selected.title}</p>}
      </>}
      {list.isFetchNextPageError && <ErrorState onRetry={() => void list.fetchNextPage({ cancelRefetch: false })} />}
      {list.hasNextPage && !list.isFetchNextPageError && <button type="button" className="btn btn-outline btn-block" disabled={list.isFetching || attach.isPending || disabled || searching} onClick={() => void list.fetchNextPage({ cancelRefetch: false })}>{list.isFetchingNextPage ? 'Đang tải…' : 'Xem thêm quỹ'}</button>}
      <p className="strong">{formatVnd(txn.amount)} · {formatDay(txn.localDate)}</p>
      <p className="savings-privacy" role="note">Người ấy sẽ thấy số tiền và ngày của giao dịch này</p>
      <p className="text-sm text-muted">Kể cả khi dòng tiền đang riêng tư. Không sao chép ghi chú và không đổi cài đặt chia sẻ. Mỗi giao dịch chỉ gắn một lần, kể cả sau khi xóa khoản góp.</p>
      {feedback.error && <p id={feedback.errorId} ref={feedback.errorRef} tabIndex={-1} className="text-sm text-danger" role="alert">{feedback.error}</p>}
      <button type="button" className="btn btn-primary btn-block" disabled={!selected || attach.isPending || disabled || searching} onClick={() => {
        if (!selected || feedback.submitting.current || !session.current()) return;
        feedback.submitting.current = true; feedback.setError(null); attach.mutate(selected.id);
      }}>{attach.isPending ? 'Đang lưu…' : 'Xác nhận góp quỹ'}</button>
      <button type="button" className="btn btn-ghost" disabled={attach.isPending} onClick={() => setChoosing(false)}>Để sau</button>
    </>}
  </section>;
}
