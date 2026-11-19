import { Suspense, useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon, type IconName } from '../../components/Icon';
import { Loading } from '../../components/StatusViews';
import { useApprovalSignals } from '../approvals/useApprovals';
import { FRIENDS_UNREAD_KEY, friendsApi } from './api';
import { friendsPrefetchCandidates } from './lazyPages';
import { scheduleRoutePrefetch } from '../../lib/routePrefetch';

type Badge = 'friendRequests' | 'notifications';

const tabs: { to: string; label: string; icon: IconName; end: boolean; badge?: Badge }[] = [
  { to: '/friends', label: 'Bảng tin', icon: 'home', end: true },
  { to: '/friends/people', label: 'Bạn bè', icon: 'users', end: false, badge: 'friendRequests' },
  { to: '/friends/notifications', label: 'Thông báo', icon: 'bell', end: false, badge: 'notifications' },
  { to: '/friends/me', label: 'Tôi', icon: 'user', end: false },
];

const BADGE_LABEL: Record<Badge, string> = { friendRequests: 'lời mời kết bạn', notifications: 'thông báo mới' };

function FriendsNav() {
  // One small request every 30 s for every badge (friend requests + unseen notifications).
  const unread = useQuery({ queryKey: FRIENDS_UNREAD_KEY, queryFn: friendsApi.unread, refetchInterval: 30_000, refetchOnWindowFocus: true });
  const counts: Record<Badge, number> = {
    friendRequests: unread.data?.friendRequests ?? 0,
    notifications: unread.data?.notifications ?? 0,
  };
  // Tab title + home-screen icon badge (same as the couple app's approvals).
  const notificationsSaturated = unread.data?.notificationsSaturated ?? false;
  useApprovalSignals(counts.friendRequests + counts.notifications, 'Dark Within', notificationsSaturated);

  return (
    <nav className="bottom-nav" aria-label="Điều hướng Hội bạn bè">
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => `bottom-nav__tab${isActive ? ' is-active' : ''}`}>
          {({ isActive }) => {
            const n = tab.badge ? counts[tab.badge] : 0;
            const approximate = tab.badge === 'notifications' && notificationsSaturated;
            return (
              <>
                <span className="bottom-nav__pill">
                  <Icon name={tab.icon} size={22} strokeWidth={isActive ? 2.4 : 2} />
                  {(n > 0 || approximate) && (
                    <span className="count-badge count-badge--nav" aria-hidden="true">
                      {n >= 99 ? '99+' : approximate ? (n > 0 ? `${n}+` : '•') : n}
                    </span>
                  )}
                </span>
                <span>{tab.label}</span>
                {(n > 0 || approximate) && tab.badge && (
                  <span className="visually-hidden">
                    {approximate && n === 0
                      ? ', Số thông báo chưa được đếm đầy đủ'
                      : `, ${approximate ? 'Ít nhất ' : ''}${n} ${BADGE_LABEL[tab.badge]}`}
                  </span>
                )}
              </>
            );
          }}
        </NavLink>
      ))}
    </nav>
  );
}

/** Shell of the hidden friends space: page content + its own bottom navigation (blue theme set by App). */
export function FriendsLayout() {
  const pathname = useLocation().pathname;
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  useEffect(() => scheduleRoutePrefetch(friendsPrefetchCandidates, () => pathRef.current), []);

  return (
    <div className="app-shell">
      <main className="app-content">
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>
      <FriendsNav />
    </div>
  );
}
