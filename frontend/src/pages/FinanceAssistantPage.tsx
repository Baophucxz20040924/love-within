import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../components/BottomSheet';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import { ASSISTANT_KEY, assistantApi } from '../features/finance/assistantApi';
import { AssistantChat, AssistantConsent, InsightsCard, NoteNudge, errorText } from '../features/finance/AssistantViews';
import type { AssistantState } from '../lib/types';

/** AI spending assistant over my own cash flow (last month + this month). plan/FINANCE_ASSISTANT_PLAN.md */
export function FinanceAssistantPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  // Notes edited on /finance change the "stale" flag, so always refetch on open.
  const state = useQuery({ queryKey: ASSISTANT_KEY, queryFn: assistantApi.state, staleTime: 0 });

  const consent = useMutation({
    mutationFn: assistantApi.consent,
    onSuccess: () => qc.invalidateQueries({ queryKey: ASSISTANT_KEY }),
    onError: (err) => toast.error(errorText(err)),
  });

  const insights = useMutation({
    mutationFn: (refresh: boolean) => assistantApi.insights(refresh),
    onSuccess: (r) =>
      qc.setQueryData<AssistantState>(ASSISTANT_KEY, (s) => (s ? { ...s, insights: r.insights, stale: r.stale, coverage: r.coverage } : s)),
    onError: (err) => toast.error(errorText(err)),
  });

  const clear = useMutation({
    mutationFn: (revoke: boolean) => assistantApi.clear(revoke),
    onSuccess: async (_r, revoke) => {
      setMenuOpen(false);
      toast.info(revoke ? 'Đã tắt trợ lý và xóa dữ liệu phân tích' : 'Đã xóa cuộc trò chuyện');
      await qc.invalidateQueries({ queryKey: ASSISTANT_KEY });
    },
    onError: (err) => toast.error(errorText(err)),
  });

  // First visit after consenting: generate the insights once without a tap. After "Xóa", wait for the user.
  const autoRan = useRef(false);
  const s = state.data;
  const shouldAuto = !!s && s.consented && s.coverage.txnCount > 0 && !s.insights;
  useEffect(() => {
    if (!shouldAuto || autoRan.current) return;
    autoRan.current = true;
    insights.mutate(false);
  }, [shouldAuto, insights]);

  return (
    <Page
      title="Trợ lý chi tiêu"
      subtitle="Phân tích tháng trước và tháng này"
      back="/finance"
      actions={
        s?.consented ? (
          <button type="button" className="icon-btn" aria-label="Tùy chọn trợ lý" onClick={() => setMenuOpen(true)}>
            <Icon name="moreHorizontal" />
          </button>
        ) : undefined
      }
    >
      {state.isLoading && <Skeleton height={160} count={2} />}
      {state.isError && <ErrorState onRetry={() => void state.refetch()} />}

      {s && !s.consented && <AssistantConsent pending={consent.isPending} onAccept={() => consent.mutate()} />}

      {s?.consented && s.coverage.txnCount === 0 && (
        <div className="card">
          <EmptyState
            art="🧾"
            title="Chưa có giao dịch để phân tích"
            hint="Trợ lý cần giao dịch trong tháng trước hoặc tháng này. Liên kết ngân hàng rồi quay lại nhé."
            action={
              <Link to="/finance" className="btn btn-outline">
                <Icon name="creditCard" size={18} /> Về Dòng tiền
              </Link>
            }
          />
        </div>
      )}

      {s?.consented && s.coverage.txnCount > 0 && (
        <>
          <InsightsCard
            coverage={s.coverage}
            insights={s.insights}
            stale={s.stale}
            pending={insights.isPending}
            onGenerate={(refresh) => insights.mutate(refresh)}
          />
          <NoteNudge coverage={s.coverage} />
          <AssistantChat messages={s.messages} />
        </>
      )}

      <BottomSheet open={menuOpen} onClose={() => setMenuOpen(false)} title="Tùy chọn trợ lý">
        <div className="stack">
          <button type="button" className="btn btn-secondary btn-block" disabled={clear.isPending} onClick={() => clear.mutate(false)}>
            <Icon name="trash" size={18} /> Xóa cuộc trò chuyện và phân tích
          </button>
          <button type="button" className="btn btn-danger btn-block" disabled={clear.isPending} onClick={() => clear.mutate(true)}>
            <Icon name="lock" size={18} /> Tắt trợ lý (thu hồi đồng ý)
          </button>
          <p className="text-sm text-muted">
            Tắt trợ lý sẽ xóa cuộc trò chuyện và ngừng gửi dữ liệu cho Beeknoee. Giao dịch và ghi chú của bạn vẫn giữ nguyên.
          </p>
        </div>
      </BottomSheet>
    </Page>
  );
}
