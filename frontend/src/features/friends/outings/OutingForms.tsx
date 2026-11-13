import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BottomSheet } from '../../../components/BottomSheet';
import { Icon } from '../../../components/Icon';
import { formatVnd } from '../../../lib/format';
import type { FriendEventDetail } from '../../../lib/types';
import { friendsApi, FRIENDS_OVERVIEW_KEY } from '../api';
import { outingsApi } from './api';
import { useOutingOperation, type OutingOperation } from './useOutingOperation';
import type { Allocation, ExpenseInput, OutingExpense, OutingLedger, OutingView, Participant } from './types';
import { canReportSettlement, expenseParticipantIds, outingLimits } from './presentation';
import './outings.css';

export function CapacityMessage({ outing }: { outing: OutingLedger }) {
  const c = outing.capacity, limits = outingLimits(outing);
  const near = (count: { used: number; max: number }) => count.used >= count.max * .9;
  return <div className="outing-capacity" aria-live="polite">
    {(limits.ordinaryClosed || near(c.ordinaryOperations) || near(c.edits)) && <div className="outing-notice outing-notice--warning"><Icon name="alert" size={18} /><p>Thao tác thường {c.ordinaryOperations.used}/{c.ordinaryOperations.max}; sửa tiền/thành viên {c.edits.used}/{c.edits.max}.{limits.ordinaryClosed ? ' Đã khóa thêm/sửa và ý kiến phản đối mới. Bạn vẫn có quyền không đồng ý; không ai được chốt thay.' : limits.editsClosed ? ' Đã hết lượt sửa tiền/thành viên.' : ' Sắp tới giới hạn. Hãy đối chiếu trước khi sửa tiếp.'} Chốt sổ và xử lý thanh toán có ngân sách riêng.</p></div>}
    {(near(c.participants) || near(c.expenses)) && <p className="outing-hint">Chỗ thành viên {c.participants.used}/{c.participants.max}; khoản chi {c.expenses.used}/{c.expenses.max}. Người đã từ chối và khoản đã hủy vẫn chiếm chỗ lịch sử.</p>}
    {(near(c.settlements) || near(c.reservedOperations)) && <div className="outing-notice outing-notice--warning"><Icon name="alert" size={18} /><p>Lời báo chuyển {c.settlements.used}/{c.settlements.max}; thao tác dự phòng {c.reservedOperations.used}/{c.reservedOperations.max}. {c.finalSettlementSlots ? '49 chỗ cuối chỉ dùng cho khoản bằng toàn bộ nợ hoặc phần được nhận đã xác nhận của ít nhất một bên. Xử lý lời báo đang chờ trước nếu không đủ phần còn trống.' : 'Lời báo đã hủy/từ chối vẫn chiếm chỗ.'} Hết chỗ không có nghĩa đã trả xong; giữ lịch sử để đối chiếu và cần chuyển đổi sổ có phiên bản, không xóa nợ hay tự chốt.</p></div>}
  </div>;
}

export function OperationMessage({ operation }: { operation: OutingOperation }) {
  return <>{operation.error && <div className="outing-notice outing-notice--warning" role="alert"><Icon name="alert" size={18} /><div><p>{operation.error}</p>{operation.stale && <><p>Đã yêu cầu tải bản mới. Nội dung bạn nhập vẫn được giữ. Hãy kiểm tra số dư và phần chia trước khi gửi lại.</p><button type="button" className="btn btn-outline" onClick={operation.reset}>Tôi đã kiểm tra, sửa bản nháp</button></>}</div></div>}</>;
}

function FormShell({ title, children, operation, dirty, onClose, onSubmit, submitLabel, valid = true }: {
  title: string; children: ReactNode; operation: OutingOperation; dirty: boolean; onClose: () => void;
  onSubmit: () => void; submitLabel: string; valid?: boolean;
}) {
  const [discard, setDiscard] = useState(false);
  const close = () => { if (operation.busy || operation.uncertain) return; if (dirty) setDiscard(true); else onClose(); };
  return <BottomSheet open onClose={close} title={title}>
    <form className="outing-form" onSubmit={(e: FormEvent) => { e.preventDefault(); if (!operation.busy && !operation.stale && (operation.uncertain || valid)) onSubmit(); }}>
      <fieldset disabled={operation.locked} className="outing-form__fields">{children}</fieldset>
      <OperationMessage operation={operation} />
      <div className="outing-form__footer"><button className="btn btn-primary btn-block" type="submit" disabled={operation.busy || operation.stale || (!operation.uncertain && !valid)}>{operation.busy ? 'Đang lưu…' : operation.uncertain ? 'Thử lại cùng yêu cầu' : submitLabel}</button><button type="button" className="btn btn-ghost btn-block" disabled={operation.busy || operation.uncertain} onClick={close}>Để sau</button></div>
    </form>
    <BottomSheet open={discard} onClose={() => setDiscard(false)} title="Bỏ nội dung đang nhập?"><div className="stack"><p>Nội dung chưa gửi sẽ không được lưu.</p><button className="btn btn-primary" onClick={() => setDiscard(false)}>Tiếp tục nhập</button><button className="btn btn-ghost" onClick={onClose}>Bỏ bản nháp</button></div></BottomSheet>
  </BottomSheet>;
}

function FriendPicker({ picked, onChange, excluded = [], allowed, maxInvitees = 49 }: { picked: string[]; onChange: (ids: string[]) => void; excluded?: string[]; allowed?: string[]; maxInvitees?: number }) {
  const query = useQuery({ queryKey: FRIENDS_OVERVIEW_KEY, queryFn: friendsApi.overview });
  const [search, setSearch] = useState('');
  const available = (query.data?.friends ?? []).filter(f => !excluded.includes(f.user.id) && (!allowed || allowed.includes(f.user.id)));
  const shown = available.filter(f => f.user.displayName.toLocaleLowerCase('vi').includes(search.toLocaleLowerCase('vi')));
  return <section className="outing-picker"><div className="outing-section-head"><h3>Mời bạn bè</h3><span className="text-muted text-sm">{picked.length}/{maxInvitees} đã chọn</span></div>
    <p className="outing-hint">Chỉ người nhận lời mới được tính phần tiền. Không tự chọn theo câu trả lời đi kèo.</p>
    <input className="input" type="search" aria-label="Tìm bạn để mời" placeholder="Tìm tên bạn bè" value={search} onChange={e => setSearch(e.target.value)} />
    {query.isLoading && <p role="status">Đang tải bạn bè…</p>}
    {query.isError && <button type="button" className="btn btn-outline" onClick={() => void query.refetch()}>Tải lại bạn bè</button>}
    {query.isSuccess && !shown.length && <p className="outing-hint">{available.length ? 'Không có tên phù hợp.' : 'Chưa có bạn bè phù hợp để mời. Bạn vẫn có thể tạo buổi và mời sau.'}</p>}
    <div className="outing-picker__list">{shown.map(f => <label className="outing-check" key={f.user.id}><span className="outing-initial" aria-hidden="true">{f.user.displayName.slice(0, 1)}</span><span>{f.user.displayName}</span><input type="checkbox" checked={picked.includes(f.user.id)} disabled={!picked.includes(f.user.id) && picked.length >= maxInvitees} onChange={e => onChange(e.target.checked ? [...picked, f.user.id] : picked.filter(id => id !== f.user.id))} /></label>)}</div>
  </section>;
}

export function CreateOutingSheet({ onClose, onSaved, event }: { onClose: () => void; onSaved: (view: OutingView) => void; event?: FriendEventDetail }) {
  const initialDate = event ? event.startAt.slice(0, 10) : new Date().toLocaleDateString('en-CA');
  const [title, setTitle] = useState(event?.title ?? '');
  const [date, setDate] = useState(/^\d{4}-\d{2}-\d{2}$/.test(initialDate) ? initialDate : new Date().toISOString().slice(0, 10));
  const [picked, setPicked] = useState<string[]>([]);
  const op = useOutingOperation();
  const submit = async () => { const result = await op.run(0, meta => outingsApi.create({ ...meta, title: title.trim(), outingDate: date, inviteeIds: picked, ...(event ? { eventId: event.id } : {}) })); if (result && op.isCurrentSession()) onSaved(result.outing); };
  return <FormShell title={event ? 'Chia tiền cho kèo này' : 'Tạo buổi chia tiền'} operation={op} dirty={!!title || !!picked.length} onClose={onClose} onSubmit={() => void submit()} submitLabel="Tạo buổi chia tiền" valid={!!title.trim() && !!date && picked.length <= 49}>
    <p className="outing-form__intro">Vui cùng nhau. Rõ ràng từng khoản.</p>
    <label className="field"><span className="field__label">Tên buổi</span><input className="input" required maxLength={100} value={title} placeholder="Ăn lẩu cuối tuần" onChange={e => setTitle(e.target.value)} /></label>
    <label className="field"><span className="field__label">Ngày đi chơi</span><input className="input" required type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
    <FriendPicker picked={picked} onChange={setPicked} allowed={event?.invitedIds} />
    <div className="outing-notice"><Icon name="shield" size={18} /><p>Mỗi người tự ghi khoản mình trả. Khi chốt, tất cả thành viên phải cùng đồng ý; không ai có thể chốt thay người khác.</p></div>
    {event && <p className="outing-hint">Sổ chia tiền được giữ riêng, kể cả khi kèo bị hủy hoặc xóa.</p>}
  </FormShell>;
}

export function InviteOutingSheet({ outing, onClose }: { outing: OutingLedger; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const op = useOutingOperation(outing.id);
  return <FormShell title="Mời vào buổi chia tiền" operation={op} dirty={!!picked.length} onClose={onClose} onSubmit={() => void op.run(outing.revision, meta => outingsApi.invite(outing.id, picked, meta)).then(result => { if (result && op.isCurrentSession()) onClose(); })} submitLabel="Gửi lời mời" valid={!!picked.length && !outingLimits(outing).editsClosed && picked.length <= outingLimits(outing).rosterRemaining}>
    <CapacityMessage outing={outing} />
    <FriendPicker picked={picked} onChange={setPicked} excluded={outing.participants.map(p => p.userId)} maxInvitees={outingLimits(outing).rosterRemaining} />
    <p className="outing-hint">Còn {outingLimits(outing).rosterRemaining} chỗ trong lịch sử tối đa {outing.capacity.participants.max} người, kể cả người chờ nhận lời hoặc đã từ chối.</p>
    <p className="outing-hint">Người được mời cần tự nhận lời. Thành viên mới nhận lời sẽ làm thay đổi phiên bản chốt sổ; mọi người cần đồng ý lại.</p>
  </FormShell>;
}

export function equalAllocations(amount: number, ids: string[]): Allocation[] {
  const sorted = [...ids].sort();
  if (!sorted.length || !Number.isSafeInteger(amount) || amount <= 0) return [];
  const base = Math.floor(amount / sorted.length), remainder = amount % sorted.length;
  return sorted.map((userId, index) => ({ userId, amount: base + (index < remainder ? 1 : 0) }));
}
const money = (value: string) => /^\d+$/.test(value) ? Number(value) : NaN;

export function ExpenseSheet({ outing, expense, myId, onClose }: { outing: OutingLedger; expense?: OutingExpense; myId: string; onClose: () => void }) {
  const restricted = outing.access === 'restricted';
  const [title, setTitle] = useState(expense?.title ?? '');
  const [amountText, setAmount] = useState(expense ? String(expense.amount) : '');
  const [mode, setMode] = useState<'equal' | 'custom'>(restricted ? 'custom' : expense?.splitMode ?? 'equal');
  const accepted = outing.participants.filter(p => p.status === 'accepted');
  const originalIds = expense ? expenseParticipantIds(expense) : [];
  const [picked, setPicked] = useState<string[]>(expense ? originalIds : accepted.map(p => p.userId));
  const [custom, setCustom] = useState<Record<string, string>>(Object.fromEntries(expense ? originalIds.map(id => [id, String(expense.allocations.find(a => a.userId === id)?.amount ?? 0)]) : []));
  const op = useOutingOperation(outing.id);
  const amount = money(amountText);
  const allocations = mode === 'equal' ? equalAllocations(amount, picked) : picked.map(userId => ({ userId, amount: money(custom[userId] || '0') }));
  const sum = allocations.reduce((total, row) => total + row.amount, 0);
  const reductionValid = !restricted || (!!expense && picked.length === originalIds.length && originalIds.every(id => picked.includes(id)) && allocations.every(a => a.amount <= (expense.allocations.find(old => old.userId === a.userId)?.amount ?? 0)));
  const valid = (restricted || !!title.trim()) && Number.isSafeInteger(amount) && amount > 0 && amount <= 100_000_000 && picked.length > 0 && allocations.every(a => Number.isSafeInteger(a.amount) && a.amount >= 0) && sum === amount && reductionValid && (expense ? !outingLimits(outing).editsClosed : outingLimits(outing).canCreateExpense);
  const participants = restricted ? accepted.filter(p => originalIds.includes(p.userId)) : accepted;
  const submit = async () => {
    if (!op.uncertain && !valid) return;
    const input: ExpenseInput = { ...(restricted ? {} : { title: title.trim() }), amount, ...(mode === 'equal' ? { splitMode: 'equal', participantIds: picked } : { splitMode: 'custom', allocations }) };
    const result = await op.run(outing.revision, meta => outingsApi.expense(outing.id, input, meta, expense?.id)); if (result && op.isCurrentSession()) onClose();
  };
  return <FormShell title={expense ? 'Sửa khoản bạn đã trả' : 'Thêm chi phí'} operation={op} dirty={!!title || !!amountText} onClose={onClose} onSubmit={() => void submit()} submitLabel={expense ? 'Lưu thay đổi' : 'Lưu chi phí'} valid={valid}>
    <CapacityMessage outing={outing} />
    <div className="outing-notice"><Icon name="user" size={18} /><p>Người trả: <strong>Bạn</strong>. Chỉ ghi khoản bạn thực sự đã trả.</p></div>
    {restricted ? <p className="outing-hint">Lịch sử hạn chế: chỉ được giảm phần tiền đã có, không đổi nội dung hoặc thêm người.</p> : <label className="field"><span className="field__label">Chi cho việc gì?</span><input className="input" required maxLength={160} value={title} onChange={e => setTitle(e.target.value)} placeholder="Bữa tối, cà phê, vé xem phim…" /></label>}
    <label className="field"><span className="field__label">Số tiền (đ)</span><input className="input outing-money-input" inputMode="numeric" pattern="[0-9]+" required value={amountText} onChange={e => setAmount(e.target.value.replace(/[^0-9]/g, ''))} aria-describedby="expense-amount-hint" /><span id="expense-amount-hint" className="outing-hint">VND nguyên, tối đa 100.000.000đ mỗi khoản.</span></label>
    {!restricted && <div className="outing-choice" aria-label="Cách chia">{(['equal', 'custom'] as const).map(value => <button type="button" key={value} aria-pressed={mode === value} className={mode === value ? 'is-active' : ''} onClick={() => { setMode(value); if (value === 'custom' && !Object.keys(custom).length) setCustom(Object.fromEntries(equalAllocations(amount, picked).map(a => [a.userId, String(a.amount)]))); }}>{value === 'equal' ? 'Chia đều' : 'Theo số tiền'}</button>)}</div>}
    <section><div className="outing-section-head"><h3>Ai cùng chia khoản này?</h3></div><p className="outing-hint">Chỉ thành viên đã nhận lời. Có thể bỏ chọn chính bạn nếu bạn chỉ trả hộ.</p>
      {participants.map(p => <div className="outing-allocation" key={p.userId}><label className="outing-check"><input type="checkbox" disabled={restricted} checked={picked.includes(p.userId)} onChange={e => setPicked(e.target.checked ? [...picked, p.userId] : picked.filter(id => id !== p.userId))} /><span>{p.userId === myId ? 'Bạn' : p.displayName}</span></label>{picked.includes(p.userId) && (mode === 'custom' ? <input className="input" aria-label={`Phần của ${p.displayName}`} inputMode="numeric" value={custom[p.userId] ?? ''} placeholder="0" onChange={e => setCustom({ ...custom, [p.userId]: e.target.value.replace(/[^0-9]/g, '') })} /> : <strong>{formatVnd(allocations.find(a => a.userId === p.userId)?.amount ?? 0)}</strong>)}</div>)}
    </section>
    <div className="outing-preview" aria-live="polite"><div className="outing-row"><span>Tổng phần chia</span><strong>{Number.isFinite(sum) ? formatVnd(sum) : '—'}</strong></div>{mode === 'custom' && Number.isFinite(amount) && sum !== amount && <p className="outing-hint">{sum < amount ? `Còn thiếu ${formatVnd(amount - sum)}` : `Đang vượt ${formatVnd(sum - amount)}`} so với khoản chi.</p>}{mode === 'equal' && Number.isSafeInteger(amount) && picked.length > 0 && <p className="outing-hint">{amount % picked.length ? `${amount % picked.length}đ lẻ được chia thêm 1đ theo thứ tự ID thành viên. Các phần hiển thị ở trên là số tiền sẽ lưu.` : 'Chia tròn cho mọi người, không có phần lẻ.'}</p>}{!reductionValid && <p className="text-danger">Không được tăng phần tiền của bất kỳ ai trong lịch sử hạn chế.</p>}</div>
    {outing.phase === 'review' && <p className="outing-hint">Sửa tiền sẽ hủy các đồng ý ở phiên bản trước. Mọi người cần kiểm tra và đồng ý lại.</p>}
  </FormShell>;
}

export function SettlementSheet({ outing, myId, recipient, onClose }: { outing: OutingLedger; myId: string; recipient?: string; onClose: () => void }) {
  const mine = outing.balances.find(b => b.userId === myId);
  const available = Math.max(0, -(mine?.balance ?? 0) - (mine?.reservedOutgoing ?? 0));
  const recipients = outing.balances.filter(b => b.userId !== myId && b.balance - b.reservedIncoming > 0);
  const [to, setTo] = useState(recipient ?? recipients[0]?.userId ?? '');
  const receiver = recipients.find(b => b.userId === to);
  const maximum = Math.min(available, Math.max(0, (receiver?.balance ?? 0) - (receiver?.reservedIncoming ?? 0)));
  const [text, setText] = useState(String(maximum || ''));
  const amount = money(text);
  const op = useOutingOperation(outing.id);
  return <FormShell title="Báo đã chuyển tiền" operation={op} dirty={!!text} onClose={onClose} onSubmit={() => void op.run(outing.revision, meta => outingsApi.settlement(outing.id, to, amount, meta)).then(result => { if (result && op.isCurrentSession()) onClose(); })} submitLabel="Tôi đã chuyển khoản này" valid={canReportSettlement(outing, myId, to, amount)}>
    <CapacityMessage outing={outing} />
    <div className="outing-notice"><Icon name="alert" size={18} /><p>Ứng dụng không chuyển tiền. Chỉ báo sau khi bạn đã gửi tiền ngoài ứng dụng. Số dư chỉ đổi khi người nhận xác nhận.</p></div>
    <label className="field"><span className="field__label">Bạn đã chuyển cho</span><select className="input" value={to} onChange={e => setTo(e.target.value)}>{recipients.map(b => <option key={b.userId} value={b.userId}>{outing.participants.find(p => p.userId === b.userId)?.displayName ?? 'Thành viên'}</option>)}</select></label>
    <label className="field"><span className="field__label">Số tiền đã chuyển (đ)</span><input className="input outing-money-input" inputMode="numeric" value={text} onChange={e => setText(e.target.value.replace(/[^0-9]/g, ''))} required /><span className="outing-hint">Có thể trả một phần. Tối đa hiện tại {formatVnd(maximum)}.</span></label>
    {!!mine?.reservedOutgoing && <p className="outing-hint">{formatVnd(mine.reservedOutgoing)} bạn đã báo chuyển đang chờ xác nhận, đã được giữ chỗ và không được báo trùng.</p>}
  </FormShell>;
}

export function memberName(participants: Participant[], id: string, myId?: string) { return id === myId ? 'Bạn' : participants.find(p => p.userId === id)?.displayName ?? 'Thành viên'; }
