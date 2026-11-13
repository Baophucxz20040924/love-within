import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../components/Avatar';
import { BottomSheet } from '../components/BottomSheet';
import { Icon, type IconName } from '../components/Icon';
import { Page } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import { useAuth } from '../features/auth/AuthContext';
import { FRIENDS_UNREAD_KEY, friendProfileKey, friendsApi } from '../features/friends/api';
import { AvatarSheet } from '../features/profile/AvatarSheet';
import { ApiRequestError } from '../lib/apiClient';
import { isStandalone } from '../lib/installPrompt';

const MAX_BIO = 160;

function BioSheet({ open, onClose, userId, initial }: { open: boolean; onClose: () => void; userId: string; initial: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [bio, setBio] = useState(initial);
  useEffect(() => {
    if (open) setBio(initial);
  }, [open, initial]);

  const save = useMutation({
    mutationFn: () => friendsApi.updateMe(bio),
    onSuccess: async () => {
      toast.success('Đã lưu giới thiệu');
      onClose();
      await qc.invalidateQueries({ queryKey: friendProfileKey(userId) });
    },
  });

  useEffect(() => {
    if (open && save.isError) save.reset();
  }, [open, save.reset]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Giới thiệu ngắn">
      <form className="form" onSubmit={onSubmit}>
        <label className="field">
          <span className="field__label">Hiện trên trang cá nhân của bạn trong Hội bạn bè</span>
          <textarea className="input" value={bio} onChange={(e) => setBio(e.target.value)} maxLength={MAX_BIO} rows={3} placeholder="VD: Mê cà phê, thích leo núi" />
          <span className="char-count">
            {bio.length}/{MAX_BIO}
          </span>
        </label>
        {save.isError && <p className="form-feedback" role="alert">{save.error instanceof ApiRequestError ? save.error.message : 'Không lưu được, thử lại nhé.'}</p>}
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={save.isPending}>
          {save.isPending && <span className="spinner" aria-hidden="true" />}
          Lưu
        </button>
      </form>
    </BottomSheet>
  );
}

function Row({ to, icon, label, meta, value }: { to: string; icon: IconName; label: string; meta?: string; value?: string }) {
  return (
    <Link to={to} className="list__item">
      <span className="icon-tile" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <span className="list__body">
        <span className="list__label">{label}</span>
        {meta && (
          <span className="list__meta" style={{ display: 'block' }}>
            {meta}
          </span>
        )}
      </span>
      {value && <span className="list__value">{value}</span>}
      <Icon name="chevronRight" className="text-muted" />
    </Link>
  );
}

/** /friends/me — my photo, bio, friends, invite links, blocked people, logout. */
export function FriendsMePage() {
  const { me, logout } = useAuth();
  const myId = me?.user.id ?? '';
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [bioOpen, setBioOpen] = useState(false);
  const profile = useQuery({ queryKey: friendProfileKey(myId), queryFn: () => friendsApi.profile(myId), enabled: Boolean(myId) });
  // Shares the cache (and the 30 s poll) with the navigation badges.
  const unread = useQuery({ queryKey: FRIENDS_UNREAD_KEY, queryFn: friendsApi.unread });
  const incoming = unread.data?.friendRequests ?? 0;
  const bio = profile.data?.user.bio ?? '';

  return (
    <Page title="Tôi" subtitle="Hội bạn bè" bell={false}>
      {me && (
        <div className="card me-card">
          <button type="button" className="avatar-button" aria-label="Đổi ảnh đại diện" onClick={() => setAvatarOpen(true)}>
            <Avatar name={me.user.displayName} src={me.user.avatarUrl} size={64} ring />
            <span className="avatar-button__badge" aria-hidden="true">
              <Icon name="camera" size={14} />
            </span>
          </button>
          <div className="me-card__body">
            <p className="card__title person__name">{me.user.displayName}</p>
            <p className="text-sm text-muted">{profile.data ? `${profile.data.friendCount} bạn bè` : '…'}</p>
            <button type="button" className="text-link me-card__bio" onClick={() => setBioOpen(true)}>
              {bio || 'Thêm giới thiệu ngắn'}
            </button>
          </div>
        </div>
      )}

      <div className="list">
        <Row to={`/friends/u/${myId}`} icon="user" label="Xem trang cá nhân" meta="Như bạn bè nhìn thấy" />
        <Row to="/friends/people" icon="users" label="Bạn bè" value={incoming > 0 ? `${incoming} lời mời` : undefined} />
        <Row to="/friends/outings" icon="coins" label="Chia tiền buổi đi chơi" meta="Ghi chi phí, chốt sổ và xác nhận thanh toán" />
        <Row to="/friends/me/invites" icon="userPlus" label="Mời bạn vào hội" meta="Gửi link để bạn bè vào và kết bạn với bạn" />
        <Row to="/friends/me/blocked" icon="shield" label="Đã chặn" />
        <Row to="/friends/me/notifications" icon="bell" label="Cài đặt thông báo" meta="Báo ra màn hình khóa, ẩn nội dung" />
      </div>

      <div className="section">
        <h2 className="section__title">Tài khoản</h2>
        <div className="list">
          <div className="list__item">
            <span className="icon-tile icon-tile--neutral" aria-hidden="true">
              <Icon name="mail" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">{me?.user.displayName}</span>
              <span className="list__meta" style={{ display: 'block' }}>
                {me?.user.email}
              </span>
            </span>
          </div>
          {!isStandalone() && (
            <Link to="/install" className="list__item">
              <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                <Icon name="smartphone" size={20} />
              </span>
              <span className="list__body">
                <span className="list__label">Cài app lên điện thoại</span>
                <span className="list__meta" style={{ display: 'block' }}>
                  Mở nhanh từ màn hình chính
                </span>
              </span>
              <Icon name="chevronRight" className="text-muted" />
            </Link>
          )}
          <button type="button" className="list__item" onClick={logout}>
            <span className="icon-tile icon-tile--neutral" aria-hidden="true">
              <Icon name="logOut" size={20} />
            </span>
            <span className="list__body">
              <span className="list__label">Đăng xuất</span>
            </span>
          </button>
        </div>
        <p className="text-sm text-muted">Thành viên khác trong Hội bạn bè tìm được bạn theo tên, hoặc theo đúng email của bạn.</p>
      </div>

      <AvatarSheet
        open={avatarOpen}
        onClose={() => setAvatarOpen(false)}
        hint="Bạn bè và những người tìm thấy bạn trong Hội bạn bè sẽ thấy ảnh này."
      />
      <BioSheet open={bioOpen} onClose={() => setBioOpen(false)} userId={myId} initial={bio} />
    </Page>
  );
}
