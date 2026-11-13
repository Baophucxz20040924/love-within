import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { ErrorState, Skeleton } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import { useAuth } from '../features/auth/AuthContext';
import { pairingApi } from '../features/pairing/api';
import { ApiRequestError } from '../lib/apiClient';
import { shortName, timeAgo } from '../lib/format';

const INVITES_KEY = ['pairing', 'invites'] as const;

export function PairingPage() {
  const { me, refreshMe, logout } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // Poll so the page notices when the partner accepts (then the router moves on to Home).
  const invites = useQuery({ queryKey: INVITES_KEY, queryFn: pairingApi.listInvites, refetchInterval: 15_000, refetchOnWindowFocus: true });
  useEffect(() => {
    // Skip while the tab is hidden (unlike React Query intervals, a raw interval keeps running in the background).
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshMe();
    }, 15_000);
    return () => window.clearInterval(t);
  }, [refreshMe]);

  const message = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');
  const invalidate = () => qc.invalidateQueries({ queryKey: INVITES_KEY });

  const sendInvite = useMutation({
    mutationFn: pairingApi.invite,
    onSuccess: async () => {
      setEmail('');
      setFormError(null);
      toast.success('Đã gửi lời mời 💌');
      await invalidate();
    },
    onError: (err) => setFormError(message(err)),
  });
  const accept = useMutation({
    mutationFn: pairingApi.accept,
    onSuccess: async () => {
      toast.success('Ghép đôi thành công 💞');
      await refreshMe();
    },
    onError: (err) => toast.error(message(err)),
  });
  const reject = useMutation({ mutationFn: pairingApi.reject, onSuccess: invalidate, onError: (err) => toast.error(message(err)) });
  const cancel = useMutation({ mutationFn: pairingApi.cancel, onSuccess: invalidate, onError: (err) => toast.error(message(err)) });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!sendInvite.isPending) sendInvite.mutate(email.trim());
  }

  const received = invites.data?.filter((i) => i.direction === 'received') ?? [];
  const sent = invites.data?.filter((i) => i.direction === 'sent') ?? [];

  return (
    <div className="app-shell">
      <main className="app-content app-content--bare">
        <section className="page">
          <header className="page-header">
            <div className="page-header__titles">
              <h1 className="page-header__title">Ghép đôi</h1>
              <p className="page-header__subtitle">Xin chào {me ? shortName(me.user.displayName) : ''}</p>
            </div>
            <button type="button" className="icon-btn" onClick={logout} aria-label="Đăng xuất">
              <Icon name="logOut" />
            </button>
          </header>

          {received.length > 0 && (
            <div className="section">
              <h2 className="section__title">Lời mời dành cho bạn</h2>
              {received.map((inv) => (
                <div key={inv.id} className="card stack">
                  <div className="row">
                    <Avatar name={inv.fromDisplayName ?? '?'} size={44} />
                    <div className="grow">
                      <p className="strong">{inv.fromDisplayName ?? 'Ai đó'} muốn ghép đôi với bạn</p>
                      <p className="text-sm text-muted">{timeAgo(inv.createdAt)}</p>
                    </div>
                  </div>
                  <div className="btn-row">
                    <button type="button" className="btn btn-secondary" disabled={reject.isPending} onClick={() => reject.mutate(inv.id)}>
                      Từ chối
                    </button>
                    <button type="button" className="btn btn-primary" disabled={accept.isPending} onClick={() => accept.mutate(inv.id)}>
                      <Icon name="heart" size={18} /> Chấp nhận
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="card pair-hero">
            <div className="pair-hero__art" aria-hidden="true">
              {me && <Avatar name={me.user.displayName} src={me.user.avatarUrl} size={56} />}
              <span className="pair-hero__link" />
              <span className="avatar avatar--placeholder" style={{ width: 56, height: 56, fontSize: 22 }}>
                ?
              </span>
            </div>
            <p className="card__title">Mời người ấy vào không gian của hai bạn</p>
            <ol className="steps" style={{ textAlign: 'left', alignSelf: 'stretch' }}>
              <li>Nhập email của người ấy và gửi lời mời.</li>
              <li>Người ấy đăng ký hoặc đăng nhập bằng đúng email đó.</li>
              <li>Người ấy chấp nhận — mạng riêng của hai bạn bắt đầu.</li>
            </ol>
          </div>

          <form onSubmit={onSubmit} className="card form">
            <label className="field">
              <span className="field__label">Email người ấy</span>
              <input
                className="input"
                type="email"
                disabled={sendInvite.isPending}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="off"
                inputMode="email"
                placeholder="nguoiay@email.com"
              />
            </label>
            {formError && (
              <p className="form-error" role="alert">
                <Icon name="alert" size={18} /> {formError}
              </p>
            )}
            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={sendInvite.isPending}>
              {sendInvite.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="mail" size={18} />}
              Gửi lời mời
            </button>
          </form>

          {invites.isLoading && <Skeleton height={72} />}
          {invites.isError && <ErrorState onRetry={() => void invites.refetch()} />}

          {sent.length > 0 && (
            <div className="section">
              <h2 className="section__title">Đã gửi</h2>
              <div className="list">
                {sent.map((inv) => (
                  <div key={inv.id} className="list__item">
                    <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                      <Icon name="mail" size={20} />
                    </span>
                    <div className="list__body">
                      <p className="list__label" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {inv.toEmail}
                      </p>
                      <p className="list__meta">Đang chờ chấp nhận · {timeAgo(inv.createdAt)}</p>
                    </div>
                    <button type="button" className="btn btn-ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(inv.id)}>
                      Hủy
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
