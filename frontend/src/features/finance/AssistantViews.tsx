import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { ProgressBar } from '../../components/ProgressBar';
import { Skeleton } from '../../components/StatusViews';
import { ApiRequestError } from '../../lib/apiClient';
import { formatDay, formatVnd, timeAgo } from '../../lib/format';
import type { AssistantCoverage, AssistantInsights, AssistantMessage, AssistantState } from '../../lib/types';
import { ASSISTANT_KEY, MAX_ASSISTANT_QUESTION, SPEND_CATEGORY_LABELS, assistantApi } from './assistantApi';

export const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');

/** "30/10" (or "30/10/2025" when the year differs from `ref`). */
function shortDay(day: string, ref: string): string {
  const full = formatDay(day);
  return day.slice(0, 4) === ref.slice(0, 4) ? full.slice(0, 5) : full;
}

// ── Consent ──

export function AssistantConsent({ pending, onAccept }: { pending: boolean; onAccept: () => void }) {
  return (
    <div className="card stack">
      <div className="state__art center" aria-hidden="true">
        🤖
      </div>
      <p className="card__title center">Trợ lý chi tiêu AI</p>
      <p className="text-muted">
        Trợ lý đọc dòng tiền của bạn trong <strong>tháng trước và tháng này</strong>, dùng ghi chú để hiểu tiền đi đâu, rồi gợi ý cách chi
        tiêu và trả lời câu hỏi của bạn.
      </p>
      <ul className="bullets">
        <li>
          Dữ liệu được gửi tới <strong>Beeknoee</strong> (dịch vụ AI bên thứ ba): ngày giờ, số tiền, tiền vào hay ra và ghi chú.
        </li>
        <li>Không gửi số tài khoản, token ngân hàng hay dữ liệu của người ấy.</li>
        <li>Bạn có thể xóa cuộc trò chuyện hoặc tắt trợ lý bất cứ lúc nào.</li>
        <li>Gợi ý chỉ để tham khảo, không phải tư vấn tài chính.</li>
      </ul>
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={pending} onClick={onAccept}>
        {pending ? <span className="spinner" aria-hidden="true" /> : null} Đồng ý và bắt đầu
      </button>
    </div>
  );
}

// ── Insights ──

function CoverageLine({ coverage }: { coverage: AssistantCoverage }) {
  if (!coverage.firstDate) return null;
  const partial = coverage.firstDate > coverage.from;
  return (
    <p className="text-sm text-muted">
      Dữ liệu {shortDay(coverage.firstDate, coverage.to)} → {shortDay(coverage.to, coverage.to)} · {coverage.txnCount} giao dịch ·{' '}
      {coverage.notedCount} có ghi chú
      {partial && ' · chưa đủ 2 tháng vì app chỉ có giao dịch từ ngày liên kết'}
    </p>
  );
}

interface InsightsProps {
  coverage: AssistantCoverage;
  insights: AssistantInsights | null;
  stale: boolean;
  pending: boolean;
  onGenerate: (refresh: boolean) => void;
}

export function InsightsCard({ coverage, insights, stale, pending, onGenerate }: InsightsProps) {
  if (!insights) {
    return (
      <div className="card stack">
        <p className="card__title">Phân tích chi tiêu</p>
        <CoverageLine coverage={coverage} />
        {pending ? (
          <>
            <Skeleton height={18} count={3} />
            <p className="text-sm text-muted center">Trợ lý đang phân tích…</p>
          </>
        ) : (
          <button type="button" className="btn btn-primary btn-block" onClick={() => onGenerate(false)}>
            <Icon name="star" size={18} /> Phân tích ngay
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="card stack assist-insights">
      <div className="assist-insights__head">
        <p className="card__title">Phân tích chi tiêu</p>
        <button
          type="button"
          className="icon-btn"
          aria-label="Làm mới phân tích"
          disabled={pending}
          onClick={() => onGenerate(true)}
        >
          {pending ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={20} />}
        </button>
      </div>
      <CoverageLine coverage={coverage} />
      {stale && !pending && (
        <button type="button" className="chip chip--warning assist-insights__stale" onClick={() => onGenerate(true)}>
          Có giao dịch hoặc ghi chú mới · Làm mới
        </button>
      )}

      <p className="assist-insights__headline">{insights.headline}</p>

      {insights.categories.length > 0 && (
        <div className="stack assist-cats" aria-label="Chi tiêu theo nhóm">
          {insights.categories.map((c) => (
            <div key={c.key} className="assist-cat">
              <div className="assist-cat__row">
                <span className={c.key === 'unnoted' ? 'text-muted' : undefined}>{SPEND_CATEGORY_LABELS[c.key]}</span>
                <span className="num">
                  {formatVnd(c.amount)} <span className="text-muted">· {Math.round(c.share * 100)}%</span>
                </span>
              </div>
              <ProgressBar value={c.share * 100} label={`${SPEND_CATEGORY_LABELS[c.key]} ${Math.round(c.share * 100)}%`} />
            </div>
          ))}
          <p className="text-sm text-muted">Nhóm được trợ lý ước tính từ ghi chú. Số tiền do app tính.</p>
        </div>
      )}

      {insights.observations.length > 0 && (
        <ul className="bullets">
          {insights.observations.map((o, i) => (
            <li key={i}>{o}</li>
          ))}
        </ul>
      )}

      {insights.suggestions.length > 0 && (
        <div className="stack">
          <p className="strong">Gợi ý</p>
          {insights.suggestions.map((s, i) => (
            <div key={i} className="assist-tip">
              <p className="strong">{s.title}</p>
              {s.detail && <p className="text-sm text-muted">{s.detail}</p>}
              {s.estimatedSavingVnd ? (
                <span className="chip chip--success">Tiết kiệm ~{formatVnd(s.estimatedSavingVnd)}/tháng</span>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <p className="text-sm text-muted">Cập nhật {timeAgo(insights.generatedAt)} · Gợi ý chỉ để tham khảo.</p>
    </div>
  );
}

/** Notes are the only hint of where money went, so nudge the user to add them. */
export function NoteNudge({ coverage }: { coverage: AssistantCoverage }) {
  if (coverage.outUnnotedCount === 0) return null;
  return (
    <Link to="/finance" className="attention">
      <span className="icon-tile icon-tile--warning" aria-hidden="true">
        <Icon name="list" />
      </span>
      <span className="attention__body">
        <span className="attention__title" style={{ display: 'block' }}>
          {coverage.outUnnotedCount} khoản chi chưa có ghi chú
        </span>
        <span className="attention__meta attention__meta--wrap" style={{ display: 'block' }}>
          Thêm ghi chú để trợ lý biết tiền đi đâu và gợi ý chính xác hơn.
        </span>
      </span>
      <Icon name="chevronRight" />
    </Link>
  );
}

// ── Chat ──

const QUICK_QUESTIONS = [
  'Tháng này mình tiêu gì nhiều nhất?',
  'So với tháng trước thì sao?',
  'Gợi ý ngân sách cho tuần tới',
  'Khoản nào nên cắt giảm?',
];

function resize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(120, el.scrollHeight)}px`;
}

function Bubble({ role, children }: { role: AssistantMessage['role']; children: ReactNode }) {
  return (
    <div className={`assist-msg${role === 'user' ? ' assist-msg--me' : ''}`}>
      {role === 'assistant' && (
        <span className="assist-msg__avatar" aria-hidden="true">
          🤖
        </span>
      )}
      <div className="assist-msg__bubble">{children}</div>
    </div>
  );
}

export function AssistantChat({ messages }: { messages: AssistantMessage[] }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: (message: string) => assistantApi.chat(message),
    onMutate: (message) => {
      setPendingQuestion(message);
      setText('');
      requestAnimationFrame(() => resize(inputRef.current));
    },
    onSuccess: (r) => {
      qc.setQueryData<AssistantState>(ASSISTANT_KEY, (s) => (s ? { ...s, messages: [...s.messages, r.question, r.reply] } : s));
    },
    onError: (_err, message) => {
      // Keep the question so it can be sent again.
      setText((t) => t || message);
    },
    onSettled: () => setPendingQuestion(null),
  });

  // Follow the conversation only after the user asks something (not on page open, so insights stay in view).
  const asked = useRef(false);
  useEffect(() => {
    if (pendingQuestion) asked.current = true;
    if (asked.current) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [pendingQuestion, messages.length]);

  function ask(message: string) {
    const m = message.trim();
    if (!m || send.isPending) return;
    send.mutate(m);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    ask(text);
  }

  // Desktop: Enter sends, Shift+Enter adds a line. Phones: Enter adds a line.
  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !window.matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      ask(text);
    }
  }

  return (
    <section className="stack assist-chat" aria-label="Hỏi trợ lý">
      <p className="card__title">Hỏi trợ lý</p>
      {messages.length === 0 && !pendingQuestion && (
        <Bubble role="assistant">
          Chào bạn! Mình đã đọc dòng tiền tháng trước và tháng này của bạn. Bạn muốn hỏi gì về chi tiêu?
        </Bubble>
      )}
      {messages.map((m, i) => (
        <Bubble key={`${m.createdAt}-${i}`} role={m.role}>
          {m.content}
        </Bubble>
      ))}
      {pendingQuestion && (
        <>
          <Bubble role="user">{pendingQuestion}</Bubble>
          <Bubble role="assistant">
            <span className="assist-typing" role="status" aria-label="Trợ lý đang trả lời">
              <span />
              <span />
              <span />
            </span>
          </Bubble>
        </>
      )}

      {messages.length === 0 && !pendingQuestion && (
        <div className="assist-quick">
          {QUICK_QUESTIONS.map((q) => (
            <button key={q} type="button" className="chip chip--brand assist-quick__chip" onClick={() => ask(q)}>
              {q}
            </button>
          ))}
        </div>
      )}
      <div ref={endRef} />

      {send.isError && <p className="form-feedback" role="alert">{errorText(send.error)}</p>}
      <form className="comment-bar" onSubmit={onSubmit}>
        <textarea
          ref={inputRef}
          className="comment-bar__input"
          rows={1}
          value={text}
          maxLength={MAX_ASSISTANT_QUESTION}
          placeholder="Hỏi về chi tiêu của bạn…"
          aria-label="Câu hỏi cho trợ lý"
          onChange={(e) => {
            setText(e.target.value);
            resize(e.target);
          }}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="icon-btn comment-bar__send" aria-label="Gửi câu hỏi" disabled={!text.trim() || send.isPending}>
          {send.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" size={20} />}
        </button>
      </form>
    </section>
  );
}
