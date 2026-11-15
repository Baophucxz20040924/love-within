import { useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { ErrorState, Loading } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import { useAuth } from '../features/auth/AuthContext';
import { friendsApi } from '../features/friends/api';
import { announceInvite } from '../features/friends/inviteResult';
import { useFriendsTheme } from '../features/friends/useFriendsTheme';
import { ApiRequestError } from '../lib/apiClient';
import { shortName } from '../lib/format';
import { usePrivacyLock } from '../features/privacy/PrivacyBoundary';
import { canEnterHidden, isPrivacyCurrent, privacyEpoch } from '../features/privacy/store';
import { tokenStore } from '../lib/tokenStore';

/**
 * /j/:code — preview and joining are deferred until deliberate hidden-space entry.
 * Invalid links remain neutral and do not disclose the inviter.
 */
export function InviteLandingPage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { isAuthenticated, loading, space, logout } = useAuth();
  const locked = usePrivacyLock();
  const allowed = !locked && canEnterHidden();

  const preview = useQuery({
    queryKey: ['invite-preview', code],
    enabled: allowed,
    queryFn: () => friendsApi.invitePreview(code),
    retry: false,
    staleTime: 60_000,
  });
  const valid = preview.data?.valid === true;
  useFriendsTheme(valid);

  // Keep attempted codes for this mounted page: a hidden response may already have committed.
  const attempted = useRef(new Set<string>());
  const currentCode = useRef(code);
  currentCode.current = code;
  const join = useMutation({
    mutationFn: async (attempt: { code: string; epoch: number; generation: string }) => ({
      result: await friendsApi.join(attempt.code), attempt,
    }),
    onSuccess: async ({ result, attempt }) => {
      if (!isPrivacyCurrent(attempt.epoch) || !tokenStore.isCurrent(attempt.generation) || currentCode.current !== attempt.code) return;
      announceInvite(result, toast);
      await qc.invalidateQueries({ queryKey: ['friends'] });
      if (isPrivacyCurrent(attempt.epoch) && tokenStore.isCurrent(attempt.generation) && currentCode.current === attempt.code) navigate('/friends', { replace: true });
    },
    onError: (err, attempt) => {
      if (!isPrivacyCurrent(attempt.epoch) || !tokenStore.isCurrent(attempt.generation) || currentCode.current !== attempt.code) return;
      toast.error(err instanceof ApiRequestError ? err.message : 'Không dùng được link, thử lại nhé.');
      navigate('/friends', { replace: true });
    },
  });
  const autoJoin = allowed && valid && isAuthenticated && space === 'friends';
  useEffect(() => {
    if (!autoJoin || attempted.current.has(code)) return;
    attempted.current.add(code);
    join.mutate({ code, epoch: privacyEpoch(), generation: tokenStore.generation() });
  }, [autoJoin, code, join]);

  if (!allowed) return null;
  if (autoJoin && attempted.current.has(code) && !join.isPending && !join.isIdle) return (
    <main className="auth"><div className="card stack"><p>Đã xử lý lời mời. Bạn có thể kiểm tra lại trong danh sách bạn bè.</p><Link to="/friends" replace className="btn btn-primary">Về trang chủ</Link></div></main>
  );

  if (loading || preview.isLoading || autoJoin) return <Loading />;

  if (preview.isError) {
    return (
      <main className="auth">
        <div className="card stack invite-card">
          <ErrorState title="Chưa kiểm tra được link" message="Kết nối đang gián đoạn. Thử lại để kiểm tra lời mời." onRetry={() => void preview.refetch()} />
        </div>
      </main>
    );
  }

  if (!valid) {
    return (
      <main className="auth">
        <div className="card stack center invite-card">
          <span className="icon-tile icon-tile--warning invite-card__icon" aria-hidden="true">
            <Icon name="alert" />
          </span>
          <h1 className="card__title">Link không còn hiệu lực</h1>
          <p className="text-muted">Link mời này đã hết hạn, đã đủ người dùng hoặc đã bị thu hồi.</p>
          <Link to={isAuthenticated ? '/' : '/login'} replace className="btn btn-primary btn-block">
            {isAuthenticated ? 'Về trang chủ' : 'Về trang đăng nhập'}
          </Link>
        </div>
      </main>
    );
  }

  const inviter = preview.data?.inviter;
  const name = inviter ? shortName(inviter.displayName) : 'Bạn của bạn';
  const toLogin = (mode: 'login' | 'register') =>
    navigate('/friends/login', { state: { unlocked: true, mode, invite: { code, inviterName: inviter?.displayName ?? '' } } });

  return (
    <main className="auth auth--friends">
      <div className="auth__brand">
        <Avatar name={inviter?.displayName ?? '?'} src={inviter?.avatarUrl} size={88} ring />
        <h1 className="auth__title invite-title">{name} mời bạn vào Hội bạn bè</h1>
        <p className="auth__tagline">Đăng story, kết bạn và xem bài viết của bạn bè.</p>
      </div>

      {isAuthenticated ? (
        <div className="card stack">
          <p className="text-muted">Bạn đang đăng nhập Love Within. Đăng xuất để vào Hội bạn bè bằng link này.</p>
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={logout}>
            Đăng xuất và tiếp tục
          </button>
          <Link to="/" replace className="btn btn-ghost">
            Ở lại
          </Link>
        </div>
      ) : (
        <div className="card stack">
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => toLogin('login')}>
            Đăng nhập
          </button>
          <button type="button" className="btn btn-outline btn-lg btn-block" onClick={() => toLogin('register')}>
            Tạo tài khoản mới
          </button>
          <p className="text-sm text-muted center">Vào xong, bạn và {name} sẽ là bạn bè.</p>
        </div>
      )}
    </main>
  );
}
