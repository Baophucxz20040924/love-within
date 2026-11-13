import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { SegmentedControl } from '../components/SegmentedControl';
import { EmptyState, ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import { FRIEND_INVITES_KEY, friendsApi } from '../features/friends/api';
import { ApiRequestError } from '../lib/apiClient';
import { formatDate } from '../lib/format';
import type { FriendInvite } from '../lib/types';

type Days = '1' | '7' | '30';
type Uses = '1' | '5' | '20';

const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');

/** The neutral /j/ path never mentions the friends space, so a link seen over someone's shoulder reveals nothing. */
const linkOf = (code: string) => `${window.location.origin}/j/${code}`;

function statusText(inv: FriendInvite): string {
  switch (inv.status) {
    case 'active':
      return `Còn hạn đến ${formatDate(inv.expiresAt)} · ${inv.uses}/${inv.maxUses} người đã dùng`;
    case 'used_up':
      return `Đã đủ ${inv.maxUses} người`;
    case 'expired':
      return 'Hết hạn';
    default:
      return 'Đã thu hồi';
  }
}

/** /friends/me/invites — create, share and revoke invite links. Using a link makes the guest my friend. */
export function FriendsInvitesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [days, setDays] = useState<Days>('7');
  const [uses, setUses] = useState<Uses>('5');
  const [created, setCreated] = useState<FriendInvite | null>(null);
  const invites = useQuery({ queryKey: FRIEND_INVITES_KEY, queryFn: friendsApi.invites });

  const create = useMutation({
    mutationFn: () => friendsApi.createInvite(Number(days), Number(uses)),
    onSuccess: (inv) => {
      setCreated(inv);
      void qc.invalidateQueries({ queryKey: FRIEND_INVITES_KEY });
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => friendsApi.revokeInvite(id),
    onSuccess: (inv) => {
      toast.info('Đã thu hồi link');
      if (created?.id === inv.id) setCreated(null);
      void qc.invalidateQueries({ queryKey: FRIEND_INVITES_KEY });
    },
    onError: (err) => toast.error(errorText(err)),
  });

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Đã sao chép link');
    } catch {
      // Clipboard needs HTTPS; the link stays selectable in the box below.
      toast.info('Hãy giữ vào link bên dưới để sao chép');
    }
  }

  async function share(inv: FriendInvite) {
    const url = linkOf(inv.code);
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Look Within', text: 'Vào đây kết bạn với mình nhé', url });
        return;
      } catch (err) {
        if ((err as DOMException).name === 'AbortError') return;
      }
    }
    await copy(url);
  }

  const others = (invites.data ?? []).filter((i) => i.id !== created?.id);

  return (
    <Page title="Mời bạn vào hội" back="/friends/me">
      <div className="card stack">
        <p className="text-muted">
          Gửi link cho bạn bè. Người mở link đăng nhập hoặc tạo tài khoản là vào được Hội bạn bè và thành bạn bè với bạn ngay.
        </p>
        <div className="field">
          <span className="field__label">Hết hạn sau</span>
          <SegmentedControl
            mode="radio"
            disabled={create.isPending}
            ariaLabel="Thời hạn của link"
            value={days}
            onChange={setDays}
            options={[
              { value: '1', label: '1 ngày' },
              { value: '7', label: '7 ngày' },
              { value: '30', label: '30 ngày' },
            ]}
          />
        </div>
        <div className="field">
          <span className="field__label">Số người dùng được</span>
          <SegmentedControl
            mode="radio"
            disabled={create.isPending}
            ariaLabel="Số người dùng được link"
            value={uses}
            onChange={setUses}
            options={[
              { value: '1', label: '1 người' },
              { value: '5', label: '5 người' },
              { value: '20', label: '20 người' },
            ]}
          />
        </div>
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="userPlus" size={18} />}
          Tạo link mời
        </button>
      </div>

      {created && (
        <div className="card stack invite-new" role="status">
          <p className="card__title">Link mời của bạn</p>
          <input className="input invite-link" readOnly value={linkOf(created.code)} aria-label="Link mời" onFocus={(e) => e.currentTarget.select()} />
          <p className="text-sm text-muted">{statusText(created)}</p>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" onClick={() => void copy(linkOf(created.code))}>
              Sao chép
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void share(created)}>
              Chia sẻ
            </button>
          </div>
          <button type="button" className="btn btn-ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(created.id)}>
            Thu hồi link này
          </button>
        </div>
      )}

      <div className="section">
        <h2 className="section__title">Link đã tạo</h2>
        {invites.isLoading && <Skeleton height={64} count={2} />}
        {invites.isError && <ErrorState onRetry={() => void invites.refetch()} />}
        {invites.isSuccess && others.length === 0 && !created && (
          <div className="card">
            <EmptyState art="🔗" title="Chưa có link nào" hint="Tạo một link rồi gửi cho bạn bè qua Zalo, Messenger…" />
          </div>
        )}
        {others.length > 0 && (
          <div className="list">
            {others.map((inv) => (
              <div key={inv.id} className="list__item">
                <span className={`icon-tile${inv.status === 'active' ? '' : ' icon-tile--neutral'}`} aria-hidden="true">
                  <Icon name="send" size={20} />
                </span>
                <span className="list__body">
                  <span className="list__label mono">/j/{inv.code}</span>
                  <span className="list__meta person__meta">{statusText(inv)}</span>
                </span>
                {inv.status === 'active' && (
                  <>
                    <button type="button" className="icon-btn" aria-label="Chia sẻ link" onClick={() => void share(inv)}>
                      <Icon name="externalLink" size={20} />
                    </button>
                    <button type="button" className="btn btn-ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(inv.id)}>
                      Thu hồi
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Page>
  );
}
