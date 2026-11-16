import { EmptyState, ErrorState, Skeleton } from '../components/StatusViews';
import { useAuth } from '../features/auth/AuthContext';
import { approvalKey, useApprovals, type ApprovalItem } from '../features/approvals/useApprovals';
import { ProposalApprovalCard, WaterApprovalCard } from '../features/approvals/ApprovalCards';
import { MarketApprovalCard } from '../features/approvals/MarketApprovalCard';
import { shortName } from '../lib/format';

function Item({ item, mode }: { item: ApprovalItem; mode: 'incoming' | 'outgoing' }) {
  if (item.type === 'water') return <WaterApprovalCard item={item.water} mode={mode} />;
  if (item.type === 'market') return <MarketApprovalCard item={item.redemption} mode={mode} />;
  return <ProposalApprovalCard proposal={item.proposal} mode={mode} />;
}

/** Authoritative pending approvals, independent of notification read state. */
export function ApprovalsPage() {
  const { me } = useAuth();
  const partner = me?.couple?.members.find((m) => m.id !== me.user.id);
  const partnerName = partner ? shortName(partner.displayName) : 'người ấy';
  const { incoming, outgoing, isLoading, isError, refetch } = useApprovals();

  return (
    <>
      {isLoading && <Skeleton height={260} count={2} />}
      {isError && <ErrorState onRetry={() => void refetch()} />}
      {!isLoading && !isError && (
        <>
          <div className="section">
            <h2 className="section__title">
              Cần bạn duyệt <small>{incoming.length}</small>
            </h2>
            {incoming.length === 0 ? (
              <div className="card">
                <EmptyState
                  art="🎉"
                  title="Không có gì cần bạn duyệt"
                  hint={`Khi ${partnerName} gửi ảnh uống nước, đổi quà hay đề xuất mới, chúng sẽ hiện ở đây.`}
                />
              </div>
            ) : (
              incoming.map((item) => <Item key={approvalKey(item)} item={item} mode="incoming" />)
            )}
          </div>

          {outgoing.length > 0 && (
            <div className="section">
              <h2 className="section__title">
                Đang chờ {partnerName} <small>{outgoing.length}</small>
              </h2>
              {outgoing.map((item) => (
                <Item key={approvalKey(item)} item={item} mode="outgoing" />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
