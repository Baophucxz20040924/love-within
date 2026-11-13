import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BottomSheet } from '../components/BottomSheet';
import { Icon } from '../components/Icon';
import { ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useAuth } from '../features/auth/AuthContext';
import { ApiRequestError } from '../lib/apiClient';
import { formatVnd } from '../lib/format';
import { outingKey, outingsApi } from '../features/friends/outings/api';
import { CapacityMessage, ExpenseSheet, InviteOutingSheet, memberName, OperationMessage, SettlementSheet } from '../features/friends/outings/OutingForms';
import { canReportSettlement, expenseParticipantIds, outingLimits, outingDate, phaseLabel, settlementLabel } from '../features/friends/outings/presentation';
import { isLedger, type MutationMeta, type OutingExpense, type OutingResult } from '../features/friends/outings/types';
import { useOutingOperation } from '../features/friends/outings/useOutingOperation';
import '../features/friends/outings/outings.css';

type Action = { kind: 'accept' | 'decline' | 'review' | 'approve' | 'object' | 'void' | 'confirm' | 'reject' | 'cancel' | 'complete'; id?: string };
const actionTitles: Record<Action['kind'], string> = { accept: 'Nhận lời tham gia?', decline: 'Từ chối lời mời?', review: 'Mời mọi người kiểm tra sổ?', approve: 'Đồng ý chốt phiên bản này?', object: 'Chưa đồng ý với sổ này?', void: 'Hủy khoản bạn đã ghi?', confirm: 'Bạn đã thực sự nhận được tiền?', reject: 'Từ chối lời báo chuyển?', cancel: 'Hủy lời báo chuyển của bạn?', complete: 'Hoàn tất buổi chia tiền?' };
const actionButtons: Record<Action['kind'], string> = { accept: 'Nhận lời tham gia', decline: 'Từ chối lời mời', review: 'Bắt đầu chốt sổ', approve: 'Đồng ý chốt sổ', object: 'Tôi chưa đồng ý', void: 'Hủy khoản chi', confirm: 'Tôi đã nhận đủ khoản này', reject: 'Từ chối xác nhận', cancel: 'Hủy lời báo chuyển', complete: 'Đánh dấu hoàn tất' };
const sections = [{ id: 'expenses', label: 'Chi phí' }, { id: 'people', label: 'Thành viên' }, { id: 'settle', label: 'Thanh toán' }, { id: 'history', label: 'Lịch sử' }] as const;
type Section = typeof sections[number]['id'];

export function FriendOutingPage() {
  const { id = '' } = useParams();
  const { me } = useAuth();
  const myId = me?.user.id ?? '';
  const query = useQuery({ queryKey: outingKey(id), queryFn: () => outingsApi.get(id), enabled: !!id, refetchOnWindowFocus: true, retry: (count, err) => !(err instanceof ApiRequestError && [403, 404].includes(err.status)) && count < 1 });
  const accessDenied = query.error instanceof ApiRequestError && [403, 404].includes(query.error.status);
  const view = accessDenied ? undefined : query.data;
  const ledger = view && isLedger(view) ? view : null;
  const [section, setSection] = useState<Section>('expenses');
  const [expense, setExpense] = useState<OutingExpense | 'new' | null>(null);
  const [invite, setInvite] = useState(false);
  const [payment, setPayment] = useState<{ recipient?: string } | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const op = useOutingOperation(id);
  const mine = ledger?.balances.find(row => row.userId === myId);
  const members = ledger?.participants.filter(p => p.status === 'accepted') ?? [];
  const editing = !!ledger && ['collecting', 'review'].includes(ledger.phase);
  const restricted = ledger?.access === 'restricted';
  const limits = ledger ? outingLimits(ledger) : null;
  const canReport = !!ledger && ledger.balances.some(b => {
    const amount = Math.min(Math.max(0, -(mine?.balance ?? 0) - (mine?.reservedOutgoing ?? 0)), Math.max(0, b.balance - b.reservedIncoming));
    return canReportSettlement(ledger, myId, b.userId, amount);
  });
  const myConsent = members.find(p => p.userId === myId)?.consent;
  const approved = members.filter(p => p.consent?.status === 'approved' && p.consent.financeRevision === ledger?.financeRevision).length;
  const pending = ledger?.settlements.filter(s => s.status === 'pending') ?? [];
  const canComplete = ledger?.phase === 'settling' && ledger.balances.every(b => b.balance === 0) && !pending.length;
  const name = (userId: string) => memberName(ledger?.participants ?? [], userId, myId);
  const requestAction = (next: Action) => { op.reset(); setAction(next); };
  const submitAction = async () => {
    if (!view || !action || op.stale) return;
    const send = (meta: MutationMeta): Promise<OutingResult> => {
      switch (action.kind) {
        case 'accept': case 'decline': return outingsApi.membership(id, action.kind, meta);
        case 'review': return outingsApi.review(id, meta);
        case 'approve': case 'object': return outingsApi.consent(id, action.kind, view.financeRevision, meta);
        case 'void': return outingsApi.voidExpense(id, action.id!, meta);
        case 'confirm': case 'reject': case 'cancel': return outingsApi.resolve(id, action.id!, action.kind, meta);
        case 'complete': return outingsApi.complete(id, meta);
      }
    };
    const result = await op.run(view.revision, send); if (result && op.isCurrentSession()) setAction(null);
  };
  const targetPayment = ledger?.settlements.find(s => s.id === action?.id);
  const targetExpense = ledger?.expenses.find(e => e.id === action?.id);
  const actionDescription = action?.kind === 'accept' ? 'Bạn sẽ xem được sổ và được chọn vào các khoản chia sau khi nhận lời. Đây không phải là đồng ý chốt nợ; bạn sẽ kiểm tra từng phần trước khi chốt.'
    : action?.kind === 'decline' ? 'Bạn không tham gia chia tiền và không được tính phần cho các khoản chi.'
    : action?.kind === 'review' ? 'Tất cả thành viên cần kiểm tra và đồng ý trên cùng phiên bản tiền. Một người chưa đồng ý có thể khiến sổ chờ vô thời hạn; người tạo không thể chốt thay.'
    : action?.kind === 'approve' ? `Bạn đồng ý các phần chia ở phiên bản tiền ${view?.financeRevision}. Khi người cuối cùng đồng ý, chi phí và thành viên sẽ bị khóa; không tự mở lại được.`
    : action?.kind === 'object' ? 'Sổ sẽ thể hiện rõ bạn chưa đồng ý. Không ai có thể chốt thay bạn. Hãy đối chiếu các khoản trước khi đồng ý lại.'
    : action?.kind === 'void' ? 'Khoản này vẫn được giữ trong lịch sử nhưng không còn tính vào số dư. Các đồng ý chốt trước đó sẽ mất hiệu lực.'
    : action?.kind === 'confirm' ? 'Chỉ xác nhận khi bạn đã kiểm tra và nhận đúng số tiền bên dưới ở ngoài ứng dụng. Xác nhận làm đổi số dư và chưa thể đảo ngược trong phiên bản này.'
    : action?.kind === 'reject' ? 'Số dư không thay đổi. Phần tiền đang giữ chỗ sẽ được giải phóng. Nếu tiền đã chuyển ngoài ứng dụng, hãy đối chiếu trước khi từ chối.'
    : action?.kind === 'cancel' ? 'Chỉ hủy lời báo trong ứng dụng, không hoàn lại tiền đã chuyển ngoài ứng dụng. Số dư không thay đổi và phần giữ chỗ được giải phóng.'
    : 'Tất cả số dư đã bằng 0 và không còn lời báo chuyển chờ xác nhận. Lịch sử vẫn được giữ để đối chiếu.';

  return <Page title="Buổi chia tiền" back="/friends/outings" bell={false} actions={<button type="button" className="icon-btn" aria-label="Cập nhật sổ chia tiền" disabled={query.isFetching} onClick={() => void query.refetch()}><Icon name="refresh" size={20} /></button>}>
    <div className="outings-page">
      {query.isLoading && <><Skeleton height={300} /><Skeleton height={64} /><Skeleton height={140} count={2} /></>}
      {query.isError && <ErrorState title={query.error instanceof ApiRequestError && query.error.status === 404 ? 'Không tìm thấy buổi chia tiền' : 'Chưa cập nhật được sổ'} message="Buổi không tồn tại, bạn không có quyền xem hoặc kết nối đang gián đoạn. Không có khoản tiền nào bị tự thay đổi." onRetry={() => void query.refetch()} />}
      {view && <>
        {!ledger ? <section className="outing-invitation"><span className="outing-empty__icon"><Icon name="users" size={28} /></span><p className="outing-eyebrow">{view.myMembership === 'pending' ? 'BẠN CÓ MỘT LỜI MỜI' : 'LỜI MỜI ĐÃ TỪ CHỐI'}</p><h2>{view.title}</h2><p className="text-muted">{outingDate(view.outingDate)}</p><p>{view.myMembership === 'pending' ? 'Nhận lời để cùng ghi và kiểm tra các khoản chi. Chưa nhận lời thì bạn chưa được tính phần tiền và chưa xem được sổ.' : 'Bạn đã từ chối lời mời này, không được tính phần tiền và không xem được sổ.'}</p>{view.myMembership === 'pending' && <div className="outing-actions"><button className="btn btn-primary" onClick={() => requestAction({ kind: 'accept' })}>Nhận lời tham gia</button><button className="btn btn-ghost" onClick={() => requestAction({ kind: 'decline' })}>Từ chối</button></div>}<p className="outing-hint">Nhận lời không phải đồng ý nợ. Chốt sổ cần tất cả thành viên đồng ý riêng.</p></section> : <>
          {restricted && <div className="outing-notice outing-notice--warning"><Icon name="shield" size={20} /><div><strong>Lịch sử tài chính hạn chế</strong><p>Quan hệ bạn bè đã thay đổi hoặc có chặn trong nhóm. Không thêm người hay khoản chi mới. Phần tiền cũ vẫn giữ nguyên; bạn vẫn đối chiếu, chốt và xử lý thanh toán của mình.</p></div></div>}
          <section className="outing-hero"><div className="outing-hero__top"><span className="outing-hero__phase"><Icon name={ledger.phase === 'completed' ? 'check' : 'clock'} size={15} />{phaseLabel[ledger.phase]}</span><span className="outing-hero__revision">Phiên bản tiền {ledger.financeRevision}</span></div><h2>{ledger.title}</h2><p className="outing-hero__meta">{outingDate(ledger.outingDate)} · {members.length} thành viên</p><div className="outing-hero__balance"><p>{(mine?.balance ?? 0) < 0 ? 'Bạn cần trả' : (mine?.balance ?? 0) > 0 ? 'Bạn được nhận' : 'Bạn đã cân bằng'}</p><strong>{formatVnd(Math.abs(mine?.balance ?? 0))}</strong></div><div className="outing-hero__total"><span>Tổng chi phí buổi này</span><span>{formatVnd(ledger.totalExpenses)}</span></div>{editing && <p className="outing-hero__footnote">Số dư tạm tính, có thể thay đổi trước khi tất cả cùng chốt.</p>}{pending.length > 0 && <p className="outing-hero__footnote">Có {pending.length} khoản báo chuyển chờ xác nhận. Chưa tính vào số dư.</p>}</section>
          <ol className="outing-phases" aria-label="Các giai đoạn">{(['collecting', 'review', 'settling', 'completed'] as const).map((phase, index) => <li key={phase} aria-current={ledger.phase === phase ? 'step' : undefined}><span>{index + 1}</span>{['Ghi chi phí', 'Chốt sổ', 'Thanh toán', 'Hoàn tất'][index]}</li>)}</ol>
          <CapacityMessage outing={ledger} />
          <div className="outing-phase-action">
            {editing && !restricted && <button className="btn btn-primary" disabled={!limits?.canCreateExpense} onClick={() => setExpense('new')}><Icon name="plus" size={18} /> Thêm chi phí</button>}
            {ledger.phase === 'collecting' && <button className={`btn ${restricted ? 'btn-primary' : 'btn-outline'}`} disabled={!limits?.canReview} onClick={() => requestAction({ kind: 'review' })}>Đề nghị chốt sổ</button>}
            {ledger.phase === 'review' && <div className="outing-review"><div className="outing-section-head"><strong>{approved}/{members.length} người đã đồng ý</strong><span className="outing-hint">Cùng phiên bản {ledger.financeRevision}</span></div><p className="outing-hint">Chỉ chốt khi tất cả cùng đồng ý. Thay đổi tiền hoặc người tham gia sẽ yêu cầu đồng ý lại.</p><div className="outing-actions"><button className="btn btn-primary" disabled={!limits?.canReview || (myConsent?.status === 'approved' && myConsent.financeRevision === ledger.financeRevision)} onClick={() => requestAction({ kind: 'approve' })}>{myConsent?.status === 'approved' && myConsent.financeRevision === ledger.financeRevision ? 'Bạn đã đồng ý' : 'Kiểm tra xong, đồng ý chốt'}</button><button className="btn btn-ghost" disabled={limits?.ordinaryClosed} onClick={() => requestAction({ kind: 'object' })}>Chưa đồng ý</button></div></div>}
            {ledger.phase === 'settling' && (canComplete ? <button className="btn btn-primary" disabled={limits?.reservedClosed} onClick={() => requestAction({ kind: 'complete' })}><Icon name="check" size={18} /> Hoàn tất buổi</button> : (mine?.balance ?? 0) < 0 ? <button className="btn btn-primary" disabled={!canReport} onClick={() => setPayment({})}>Báo đã chuyển tiền</button> : <p className="outing-hint">{pending.some(s => s.toUserId === myId) ? 'Có lời báo chuyển cần bạn kiểm tra ở mục Thanh toán.' : 'Chỉ xác nhận sau khi bạn thực sự nhận tiền.'}</p>)}
            {ledger.phase === 'completed' && <div className="outing-completed"><Icon name="check" size={20} /><p>Đã đối chiếu xong. Hẹn nhau ở buổi vui tiếp theo.</p></div>}
          </div>
          <nav className="outing-sections" aria-label="Nội dung sổ chia tiền">{sections.map(item => <button key={item.id} aria-pressed={section === item.id} className={section === item.id ? 'is-active' : ''} onClick={() => setSection(item.id)}>{item.label}{item.id === 'settle' && pending.length > 0 && <span className="outing-section-dot" aria-label={`${pending.length} chờ xác nhận`}>{pending.length}</span>}</button>)}</nav>
          <section className="outing-panel" aria-label={sections.find(s => s.id === section)?.label}>
            {section === 'expenses' && <><div className="outing-section-head"><h3>Những khoản đã chi</h3><span className="outing-hint">{ledger.expenses.filter(e => e.status === 'active').length} khoản đang tính</span></div>{!ledger.expenses.length && <div className="outing-empty"><Icon name="coins" size={28} /><h3>Chưa có khoản chi nào</h3><p>Ai trả tiền thì tự ghi khoản đó. Chọn đúng những người cùng chia, rồi kiểm tra phần mỗi người trước khi lưu.</p></div>}<div className="outing-expenses">{ledger.expenses.map(e => <article className={`outing-expense${e.status === 'void' ? ' outing-expense--void' : ''}`} key={e.id}><div className="outing-row"><div><h4>{e.title ?? 'Khoản chi đã lưu'}</h4><p className="outing-hint">{name(e.payerId)} đã trả · {e.splitMode === 'equal' ? 'Chia đều' : 'Theo số tiền'}{e.status === 'void' ? ' · Đã hủy' : ''}</p></div><strong>{formatVnd(e.amount)}</strong></div><details><summary>Xem phần chia · {expenseParticipantIds(e).length} người</summary><div className="outing-allocation-list">{expenseParticipantIds(e).map(userId => <div className="outing-row" key={userId}><span>{name(userId)}</span><span>{formatVnd(e.allocations.find(a => a.userId === userId)?.amount ?? 0)}</span></div>)}</div></details>{editing && e.payerId === myId && e.status === 'active' && <div className="outing-expense__actions"><button className="btn btn-ghost" disabled={limits?.editsClosed} onClick={() => setExpense(e)}><Icon name="edit" size={16} />{restricted ? 'Giảm phần tiền' : 'Sửa khoản'}</button><button className="btn btn-ghost text-danger" disabled={limits?.editsClosed} onClick={() => requestAction({ kind: 'void', id: e.id })}>Hủy khoản</button></div>}</article>)}</div><p className="outing-hint outing-cap-note">Tối đa 200 khoản, gồm cả khoản đã hủy. Tổng buổi không quá 10 tỷ đồng.</p></>}
            {section === 'people' && <><div className="outing-section-head"><h3>Cùng buổi này</h3>{editing && !restricted && ledger.creatorId === myId && <button className="btn btn-outline" disabled={limits?.editsClosed || !limits?.rosterRemaining} onClick={() => setInvite(true)}><Icon name="userPlus" size={16} /> Mời thêm</button>}</div><p className="outing-hint">Người chưa nhận lời không được tính phần tiền. Nhận lời và đồng ý chốt là hai bước riêng.</p><div className="outing-people">{ledger.participants.map(p => { const balance = ledger.balances.find(b => b.userId === p.userId); const consent = p.consent?.financeRevision === ledger.financeRevision ? p.consent.status : null; return <article className="outing-person" key={p.userId}><div className="outing-row"><span className="outing-initial" aria-hidden="true">{p.displayName.slice(0, 1)}</span><div className="outing-person__name"><h4>{name(p.userId)}</h4><p className="outing-hint">{p.userId === ledger.creatorId ? 'Người tạo · ' : ''}{p.status === 'pending' ? 'Chờ nhận lời' : p.status === 'declined' ? 'Đã từ chối' : consent === 'approved' ? 'Đã đồng ý chốt' : consent === 'objected' ? 'Chưa đồng ý chốt' : 'Đã tham gia'}</p></div>{balance && <span className="outing-person__balance">{balance.balance < 0 ? 'Cần trả' : balance.balance > 0 ? 'Được nhận' : 'Cân bằng'}<strong>{formatVnd(Math.abs(balance.balance))}</strong></span>}</div>{balance && <details><summary>Đối chiếu phần tiền</summary><div className="outing-allocation-list">{[['Đã trả hộ', balance.paid], ['Phần phải chịu', balance.share], ['Đã gửi, được xác nhận', balance.sent], ['Đã nhận, đã xác nhận', balance.received]].map(([label, value]) => <div className="outing-row" key={label}><span>{label}</span><span>{formatVnd(Number(value))}</span></div>)}</div></details>}</article>; })}</div></>}
            {section === 'settle' && <><div className="outing-section-head"><h3>Chuyển ngoài app, xác nhận ở đây</h3></div><p className="outing-hint">Báo đã chuyển không có nghĩa đã thanh toán xong. Người nhận phải xác nhận; khoản chờ được giữ chỗ để không báo trùng.</p>{editing && <div className="outing-notice"><Icon name="clock" size={18} /><p>Mọi người cần cùng chốt sổ trước khi báo chuyển tiền.</p></div>}{ledger.phase === 'settling' && ledger.suggestions.length > 0 && <div className="outing-suggestions"><h4>Gợi ý đối chiếu</h4>{ledger.suggestions.map((s, index) => <div className="outing-suggestion" key={`${s.fromUserId}-${s.toUserId}-${index}`}><p><strong>{name(s.fromUserId)}</strong><span aria-hidden="true"> → </span><span className="sr-only"> chuyển cho </span><strong>{name(s.toUserId)}</strong></p><span>{formatVnd(s.amount)}</span>{s.fromUserId === myId && <button className="btn btn-outline" disabled={!canReportSettlement(ledger, myId, s.toUserId, s.amount)} onClick={() => setPayment({ recipient: s.toUserId })}>Báo đã chuyển</button>}</div>)}</div>}{!ledger.settlements.length && <div className="outing-empty"><Icon name="check" size={26} /><h3>Chưa có lời báo chuyển</h3><p>Có thể trả một phần sau khi chốt sổ. Ứng dụng không lưu ngân hàng và không tự chuyển tiền.</p></div>}{ledger.settlements.map(s => <article className="outing-settlement" key={s.id}><span className="outing-status"><Icon name={s.status === 'confirmed' ? 'check' : 'clock'} size={14} />{settlementLabel[s.status]}</span><div className="outing-row"><p><strong>{name(s.fromUserId)}</strong> → <strong>{name(s.toUserId)}</strong></p><strong>{formatVnd(s.amount)}</strong></div><p className="outing-hint">{new Date(s.createdAt).toLocaleString('vi-VN')}</p>{s.status === 'pending' && <div className="outing-actions">{s.toUserId === myId && <><button className="btn btn-primary" disabled={limits?.reservedClosed} onClick={() => requestAction({ kind: 'confirm', id: s.id })}>Xác nhận đã nhận</button><button className="btn btn-ghost" disabled={limits?.reservedClosed} onClick={() => requestAction({ kind: 'reject', id: s.id })}>Chưa nhận · Từ chối</button></>}{s.fromUserId === myId && <button className="btn btn-ghost" disabled={limits?.reservedClosed} onClick={() => requestAction({ kind: 'cancel', id: s.id })}>Hủy lời báo chuyển</button>}</div>}</article>)}</>}
            {section === 'history' && <><div className="outing-section-head"><h3>Dấu mốc và khoản đã ghi</h3></div><p className="outing-hint">Các khoản dưới đây hiển thị trạng thái hiện tại, không phải nhật ký đầy đủ từng lần sửa.</p><ol className="outing-timeline">{[{ id: 'created', at: ledger.createdAt, title: 'Tạo buổi chia tiền', detail: `${members.length} thành viên đã nhận lời` }, ...ledger.expenses.map(e => ({ id: e.id, at: e.updatedAt || e.createdAt, title: e.status === 'void' ? 'Đã hủy khoản chi' : e.title ?? 'Khoản chi đã lưu', detail: `${name(e.payerId)} · ${formatVnd(e.amount)}` })), ...ledger.settlements.map(s => ({ id: s.id, at: s.resolvedAt || s.createdAt, title: settlementLabel[s.status], detail: `${name(s.fromUserId)} → ${name(s.toUserId)} · ${formatVnd(s.amount)}` }))].sort((a, b) => b.at.localeCompare(a.at)).map(row => <li key={row.id}><span className="outing-timeline__mark" /><div><h4>{row.title}</h4><p>{row.detail}</p><time className="outing-hint" dateTime={row.at}>{new Date(row.at).toLocaleString('vi-VN')}</time></div></li>)}</ol></>}
          </section>
          {ledger.eventId && !restricted && <Link className="outing-source" to={`/friends/events/${ledger.eventId}`}><Icon name="calendar" size={18} /><span>Xem kèo của buổi này</span><Icon name="chevronRight" size={18} /></Link>}
          <p className="outing-bottom-note"><Icon name="shield" size={16} /> Sổ được giữ để đối chiếu, kể cả khi kèo hoặc quan hệ bạn bè thay đổi.</p>
          {expense && <ExpenseSheet outing={ledger} expense={expense === 'new' ? undefined : expense} myId={myId} onClose={() => setExpense(null)} />}
          {invite && <InviteOutingSheet outing={ledger} onClose={() => setInvite(false)} />}
          {payment && <SettlementSheet outing={ledger} myId={myId} recipient={payment.recipient} onClose={() => setPayment(null)} />}
        </>}
      </>}
    </div>
    <BottomSheet open={!!action} onClose={() => { if (!op.busy && !op.uncertain) { setAction(null); op.reset(); } }} title={action ? actionTitles[action.kind] : ''}>
      {action && <div className="outing-form"><p>{actionDescription}</p>{targetPayment && <div className="outing-preview"><p>{name(targetPayment.fromUserId)} → {name(targetPayment.toUserId)}</p><strong>{formatVnd(targetPayment.amount)}</strong></div>}{targetExpense && <div className="outing-preview"><p>{targetExpense.title ?? 'Khoản chi đã lưu'}</p><strong>{formatVnd(targetExpense.amount)}</strong></div>}<OperationMessage operation={op} /><button className="btn btn-primary btn-block" disabled={op.busy || op.stale || query.isFetching} onClick={() => void submitAction()}>{op.busy ? 'Đang lưu…' : op.uncertain ? 'Thử lại cùng yêu cầu' : actionButtons[action.kind]}</button><button className="btn btn-ghost btn-block" disabled={op.busy || op.uncertain} onClick={() => { setAction(null); op.reset(); }}>Quay lại kiểm tra</button></div>}
    </BottomSheet>
  </Page>;
}
