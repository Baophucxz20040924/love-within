import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { subscribeVerification } from '../realtime/verification';
import { subscribeAppLock } from '../appLock/store';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { ApiRequestError, currentAccessEpoch } from '../../lib/apiClient';
import { tokenStore } from '../../lib/tokenStore';
import { scamApi, scamKey } from './api';
import type { ScamOperation, ScamState } from './types';
import { SecretDrawer, stageLabels } from './SecretDrawer';
import { ScamLeaderboard } from './ScamLeaderboard';
import { reconcileOutgoing, type OutgoingTurn } from './outgoing';
import './scam.css';

const subscribeAccess = (notify: () => void) => {
  const a = subscribeVerification(notify), b = subscribeAppLock(notify);
  return () => { a(); b(); };
};
export function ScamGamePage() {
  const { me } = useAuth();
  const access = useSyncExternalStore(subscribeAccess, currentAccessEpoch, currentAccessEpoch);
  return me ? <ScamRoom key={`${me.user.id}:${tokenStore.generation()}`} userId={me.user.id} access={access} /> : null;
}

function Meter({ label, value }: { label: string; value: number }) {
  return <div className="scam-meter"><span>{label} <strong>{value}%</strong></span><progress aria-label={label} max={100} value={value} /></div>;
}

function ScamRoom({ userId, access }: { userId: string; access: number }) {
  const qc = useQueryClient();
  const [state, setState] = useState<ScamState | null>(null);
  const stateRef = useRef<ScamState | null>(null);
  const [draft, setDraft] = useState('');
  const [outgoing, setOutgoing] = useState<OutgoingTurn | null>(null);
  const outgoingRef = useRef<OutgoingTurn | null>(null);
  function updateOutgoing(turn: OutgoingTurn | null) { outgoingRef.current = turn; setOutgoing(turn); }
  const [consent, setConsent] = useState(false);
  const [tab, setTab] = useState<'chat' | 'board'>('chat');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [needsSync, setNeedsSync] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const live = useRef(false);
  const lock = useRef(false);
  const stopLock = useRef(false);
  const syncCount = useRef(0);
  const chat = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const epoch = useRef(currentAccessEpoch());
  const generation = useRef(tokenStore.generation());
  const valid = () => live.current && currentAccessEpoch() === epoch.current && tokenStore.generation() === generation.current;
  const actionSequence = useRef(0);
  const writeVersion = useRef(0);
  function accept(next: ScamState) {
    if (!valid()) return false;
    if (stateRef.current && next.revision < stateRef.current.revision) return false;
    stateRef.current = next;
    setState(next);
    if (next.match?.status === 'active') setTab('chat');
    updateOutgoing(reconcileOutgoing(outgoingRef.current, next));
    return true;
  }
  async function sync(signal?: AbortSignal) {
    syncCount.current++;
    const requestEpoch = epoch.current, requestWriteVersion = writeVersion.current;
    if (valid()) setSyncing(true);
    try {
      const next = await scamApi.state(signal);
      if (!valid() || requestEpoch !== epoch.current) return null;
      if (requestWriteVersion !== writeVersion.current || !accept(next)) return null;
      setNeedsSync(false);
      return next;
    } catch (e) {
      if (valid() && requestEpoch === epoch.current && requestWriteVersion === writeVersion.current && !signal?.aborted) {
        setNeedsSync(true);
        setError(e instanceof ApiRequestError ? e.message : 'Chưa đồng bộ được ván. Kết nối lại rồi bấm Đồng bộ.');
      }
      return null;
    } finally {
      syncCount.current--;
      if (valid()) setSyncing(syncCount.current > 0);
    }
  }
  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    void Promise.resolve().then(() => { if (!controller.signal.aborted) return sync(controller.signal); });
    return () => { live.current = false; controller.abort(); };
  }, []);
  useEffect(() => {
    if (epoch.current === access) return;
    epoch.current = access;
    actionSequence.current++;
    lock.current = false; stopLock.current = false;
    setSending(false); setStopping(false); setNeedsSync(true);
    if (outgoingRef.current) updateOutgoing({ ...outgoingRef.current, status: 'uncertain', message: 'Quyền truy cập đã thay đổi. Đang kiểm tra kết quả gửi…' });
    const controller = new AbortController();
    const timer = setTimeout(() => void sync(controller.signal), 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [access]);
  useEffect(() => {
    const expiresAt = state?.pending?.expiresAt;
    if (!expiresAt) return;
    setNow(Date.now());
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()) + 10);
    return () => clearTimeout(timer);
  }, [state?.pending?.expiresAt]);
  // Reconcile only a pending turn, with a bounded retry budget. No idle chat polling.
  useEffect(() => {
    if (!state?.pending) return;
    const controller = new AbortController();
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (++attempts > 6 || !valid()) return;
      const next = await sync(controller.signal);
      if (!controller.signal.aborted && next?.pending) timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 3000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [state?.pending?.operationId]);
  useEffect(() => {
    if (tab === 'chat' && chat.current) chat.current.scrollTop = chat.current.scrollHeight;
  }, [state?.match?.messages, outgoing, tab]);
  useEffect(() => {
    const input = composer.current;
    if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; }
  }, [draft, tab]);

  async function run(action: (op: ScamOperation) => Promise<ScamState>, options?: { stop?: boolean; retry?: ScamOperation; sentText?: string }) {
    const isStop = options?.stop === true;
    if (isStop ? stopLock.current : lock.current || stopLock.current) return false;
    const actionEpoch = epoch.current, sequence = actionSequence.current;
    const currentAction = () => valid() && actionEpoch === epoch.current && sequence === actionSequence.current;
    if (isStop) { stopLock.current = true; setStopping(true); }
    else { lock.current = true; setSending(true); }
    writeVersion.current++;
    setError('');
    let operation: ScamOperation | undefined;
    try {
      // A stop must see the reservation revision even if the original POST is still in flight.
      const current = isStop ? await sync() : stateRef.current;
      if (!current || !currentAction()) return false;
      operation = options?.retry ?? { operationId: crypto.randomUUID(), expectedRevision: current.revision, ...(current.match ? { matchId: current.match.id } : {}) };
      if (options?.sentText !== undefined) {
        updateOutgoing({ operation, text: options.sentText.trim(), status: 'sending', message: 'Đang gửi…' });
        if (!options.retry) setDraft(value => value === options.sentText ? '' : value);
      }
      const next = await action(operation);
      if (!currentAction()) return false;
      if (!accept(next)) {
        if (operation && outgoingRef.current?.operation.operationId === operation.operationId) {
          updateOutgoing({ ...outgoingRef.current, status: 'uncertain', message: 'Ván đã thay đổi. Hãy đồng bộ kết quả gửi.' });
          setNeedsSync(true);
        }
        return false;
      }
      setNeedsSync(false);
      void qc.invalidateQueries({ queryKey: [...scamKey(userId), 'board'] });
      return true;
    } catch (e) {
      if (!currentAction()) return false;
      // Timeout/network errors can follow a committed write. Never blindly repeat a POST.
      setNeedsSync(true);
      const message = e instanceof ApiRequestError ? e.message : 'Chưa nhận được kết quả. Hãy đồng bộ trước khi thử lại.';
      // Only explicit server rejection proves failure; timeout/network/access errors remain uncertain.
      const rejected = e instanceof ApiRequestError && (e.code === 'SCAM_AI_UNAVAILABLE' || e.code === 'SCAM_AI_BUSY'
        || e.status === 400 || e.status === 422 || e.status === 429);
      if (operation && outgoingRef.current?.operation.operationId === operation.operationId) {
        updateOutgoing({ ...outgoingRef.current, status: 'uncertain', rejected, message: `${message} Đang kiểm tra trạng thái…` });
      }
      setError(message);
      const reconciled = await sync();
      if (!currentAction()) return false;
      if (operation && reconciled?.recentOperations.includes(operation.operationId)) {
        setError('');
        void qc.invalidateQueries({ queryKey: [...scamKey(userId), 'board'] });
        return true;
      }
      setError(e instanceof ApiRequestError ? e.message : 'Chưa nhận được kết quả. Hãy đồng bộ trước khi thử lại.');
      return false;
    } finally {
      if (currentAction()) {
        if (isStop) { stopLock.current = false; setStopping(false); }
        else { lock.current = false; setSending(false); }
      }
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || text.length > 1200 || !state?.match || state.match.status !== 'active' || state.pending || needsSync || outgoingRef.current) return;
    void run(op => scamApi.message(op, text), { sentText: draft });
  }
  const match = state?.match;
  const active = match?.status === 'active';
  const boardAvailable = Boolean(match && ['won', 'lost', 'stopped'].includes(match.status));
  const busy = sending || stopping || syncing || Boolean(state?.pending) || needsSync || Boolean(outgoing && outgoing.status !== 'failed');
  const currentStage = ['account', 'password', 'otp'].indexOf(match?.stage ?? 'account');
  return <div className="scam-page">
    <header className="scam-page__heading">
      <Link to="/friends" className="scam-back">← Hội bạn bè</Link>
      {!active && <><div className="scam-page__title"><span className="scam-page__mark" aria-hidden="true">💬</span><div><p className="scam-eyebrow">Góc giải trí · Solo AI</p><h1>Scam with Famous People</h1></div></div>
      <p className="scam-page__subtitle">Một cuộc trò chuyện. Ba thử thách. Bạn thuyết phục được ai?</p></>}
      {active && <h1 className="visually-hidden">Scam with Famous People</h1>}
      {state?.mock && <strong className="scam-mock">Mock AI</strong>}
      <span className="scam-fiction">AI nhập vai · Chỉ dùng thông tin giả lập</span>
    </header>
    <div className="scam-tabs" role="group" aria-label="Nội dung">
      <button className="btn btn-outline" aria-pressed={!boardAvailable || tab === 'chat'} onClick={() => setTab('chat')}>Time to scam</button>
      {boardAvailable && <button className="btn btn-outline" aria-pressed={tab === 'board'} onClick={() => setTab('board')}>Bảng xếp hạng</button>}
    </div>
    {boardAvailable && tab === 'board' ? <ScamLeaderboard userId={userId} /> : <>
      {error && <p role="alert" className="form-feedback">{error}</p>}
      <div className="scam-sync"><button className="text-link" disabled={syncing} onClick={() => { setError(''); void sync(); }}>{syncing ? 'Đang đồng bộ…' : 'Đồng bộ ván'}</button>{needsSync && <span role="status"> Cần đồng bộ trước thao tác tiếp.</span>}</div>
      {!state && !error && <p role="status">Đang tải ván…</p>}
      {state && (!match || !active) && <section className="card scam-start">
        {match ? <div className={`scam-result scam-result--${match.status}`} role="status">
          <span className="scam-result__art" aria-hidden="true">{match.status === 'won' ? '🏆' : match.status === 'lost' ? '📵' : '☕'}</span>
          <div><strong>{match.status === 'won' ? 'Bạn đã thắng!' : match.status === 'lost' ? 'Nhân vật đã ngắt liên lạc.' : 'Đã dừng scam.'}</strong><p>{match.score}/600 điểm · Tổng {state.wins} ván thắng.</p></div>
        </div> : <div className="scam-lobby">
          <div className="scam-lobby__cast" aria-hidden="true"><span>🍖</span><span>🕶️</span><span>⚡</span></div>
          <h2>Gặp người quen. Kể chuyện mới.</h2>
          <p>Nhân vật ngẫu nhiên, tính cách riêng. Bắt chuyện và thử xem bạn có thể đi xa đến đâu.</p>
        </div>}
        <ol className="scam-howto" aria-label="Ba bước ghi điểm">
          {(['Tài khoản', 'Password', 'OTP'] as const).map((label, index) => <li key={label}><span className="scam-howto__number">{index + 1}</span><strong>{label}</strong><span>+{(index + 1) * 100} điểm</span></li>)}
        </ol>
        <p className="scam-start__hint">Giữ lòng tin và mở khung xác nhận khi nhân vật chia sẻ thông tin. Nhân vật có thể chủ động ngắt liên lạc nếu không muốn nói tiếp.</p>
        <label className="scam-consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /><span>Tôi chỉ dùng nội dung hư cấu, hiểu rằng chat được gửi tới AI provider cấu hình và điểm cao nhất/số ván thắng sẽ công khai trên BXH Hội bạn bè. Không nhập dữ liệu thật.</span></label>
        <button className="btn btn-primary scam-start__button" disabled={!consent || busy || syncing} onClick={() => void run(scamApi.start)}>{match ? 'Chơi lại · Nhân vật mới' : 'Bắt đầu scam'}</button>
      </section>}
      {match && <section className="scam-room" aria-label="Cuộc trò chuyện">
        <header className="scam-character"><span className="scam-character__avatar" aria-hidden="true">{match.character.emoji}</span><div className="scam-character__body"><span className="scam-eyebrow">{active ? 'Cuộc trò chuyện đang diễn ra' : 'Cuộc trò chuyện đã kết thúc'}</span><h2><span className="visually-hidden">Đang trò chuyện với </span>{match.character.name}</h2><p>{match.character.description}</p></div><span className="scam-character__badge">AI nhập vai</span></header>
        <div className="scam-meters"><Meter label="Tin tưởng" value={match.trust} /></div>
        <div className="scam-stage"><strong>{match.score}/600 điểm</strong><span>{active ? `Đang xác nhận: ${stageLabels[match.stage]}` : 'Ván đã kết thúc'} · {match.turns} lượt</span></div>
        <ol className="scam-progress" aria-label="Tiến độ xác nhận">
          {(['account', 'password', 'otp'] as const).map((stage, index) => {
            const done = match.status === 'won' || index < currentStage;
            const current = active && index === currentStage;
            return <li key={stage} className={done ? 'is-done' : current ? 'is-current' : ''} aria-current={current ? 'step' : undefined}><span className="scam-progress__dot" aria-hidden="true">{done ? '✓' : index + 1}</span><span>{stageLabels[stage]}<small>{done ? 'Đã xác nhận' : current ? 'Hiện tại' : 'Chưa xác nhận'}</small></span></li>;
          })}
        </ol>
        <div ref={chat} className="scam-messages" role="log" aria-label="Tin nhắn" aria-live="polite" aria-relevant="additions text">
          {match.messages.map(message => <div key={message.id} className={`scam-bubble scam-bubble--${message.role}`}><span className="visually-hidden">{message.role === 'user' ? 'Bạn' : message.role === 'assistant' ? match.character.name : 'Hệ thống'}: </span>{message.text}</div>)}
          {outgoing && outgoing.operation.matchId === match.id && <div className="scam-bubble scam-bubble--user scam-outgoing" data-status={outgoing.status}><span className="visually-hidden">Bạn: </span>{outgoing.text}<small role="status">{outgoing.status === 'failed' ? 'Chưa gửi được' : outgoing.message}</small></div>}
          {(outgoing?.status === 'sending' || state?.pending) && active && <p className="scam-typing" role="status">{match.character.name} đang trả lời…</p>}
        </div>
        {active && state?.pending && <div className="scam-pending"><span>Đang chờ kết quả. Nếu chưa thấy trả lời, hãy đồng bộ; chỉ thử lại lượt cũ sau khi hết thời gian giữ.</span><button className="text-link" disabled={sending || stopping || syncing || now < state.pending.expiresAt || needsSync} onClick={() => {
          const pending = stateRef.current?.pending;
          if (pending) void run(op => scamApi.message(op, pending.text), { retry: { operationId: pending.operationId, expectedRevision: pending.expectedRevision, matchId: match.id }, sentText: pending.text });
        }}>Thử lại lượt đang chờ</button></div>}
        {active && (outgoing?.status === 'uncertain' || outgoing?.status === 'failed' || error || needsSync) && <div className="scam-send-feedback" role="alert">
          <span>{outgoing?.status === 'failed' ? `Chưa gửi được. ${error || 'Bạn có thể thử lại hoặc sửa tin nhắn.'}` : outgoing?.status === 'uncertain' ? 'Chưa xác nhận được kết quả gửi. Đồng bộ để kiểm tra; không gửi lại lượt mới khi chưa rõ kết quả.' : error || 'Cần đồng bộ trước thao tác tiếp.'}</span>
          {outgoing?.status === 'failed' ? <>
            <button className="text-link" disabled={busy} onClick={() => {
              const text = outgoing.text;
              void run(op => scamApi.message(op, text), { sentText: text, retry: { operationId: crypto.randomUUID(), expectedRevision: stateRef.current!.revision, matchId: match.id } });
            }}>Thử lại tin nhắn</button>
            <button className="text-link" disabled={busy || Boolean(draft)} onClick={() => { setDraft(outgoing.text); updateOutgoing(null); setError(''); }}>Sửa tin nhắn</button>
            <button className="text-link" disabled={busy} onClick={() => { updateOutgoing(null); setError(''); }}>Bỏ tin chưa gửi</button>
            {draft && <small>Bản nháp mới vẫn được giữ. Xóa bản nháp nếu muốn sửa tin cũ.</small>}
          </> : <button className="text-link" disabled={syncing} onClick={() => void sync()}>Đồng bộ kết quả gửi</button>}
        </div>}
        {active && state?.pending && <p className="scam-composer-status" role="status">Đang chờ nhân vật trả lời. Bạn vẫn có thể soạn tin tiếp theo.</p>}
        {active && <form className="scam-composer" onSubmit={submit}>
          <label className="visually-hidden" htmlFor="scam-message">Tin nhắn cho nhân vật</label>
          <textarea ref={composer} id="scam-message" rows={1} maxLength={1200} value={draft} placeholder="Nhắn tin… Chỉ dùng nội dung hư cấu" onChange={e => setDraft(e.target.value)} onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); }
          }} />
          <button className="btn btn-primary" disabled={busy || Boolean(outgoing) || !draft.trim()} type="submit">Gửi</button>
        </form>}
        <SecretDrawer key={match.id} match={match} busy={busy} onVerify={(stage, value) => run(op => scamApi.verify(op, stage, value))} />
        {active && <button className="btn btn-outline scam-stop" disabled={stopping || needsSync || syncing} onClick={() => {
          if (window.confirm('Dừng scam và giữ điểm đã đạt? Nhân vật sẽ không trả lời tiếp.')) void run(scamApi.stop, { stop: true });
        }}>Dừng scam</button>}
      </section>}
    </>}
  </div>;
}
