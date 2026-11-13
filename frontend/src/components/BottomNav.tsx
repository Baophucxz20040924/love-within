import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon, type IconName } from './Icon';
import { STORY_UNREAD_KEY, storiesApi } from '../features/stories/api';
import { MARKET_UNREAD_KEY, marketApi } from '../features/market/api';

type BadgeKey = 'stories' | 'market';

// Water lives inside "Nhiệm vụ" (it is one of the daily quests), not at the top level.
const tabs: { to: string; label: string; icon: IconName; end: boolean; badge?: BadgeKey }[] = [
  { to: '/', label: 'Trang chủ', icon: 'home', end: true },
  { to: '/quests', label: 'Nhiệm vụ', icon: 'quests', end: false },
  { to: '/stories', label: 'Story', icon: 'bookOpen', end: false, badge: 'stories' },
  { to: '/market', label: 'Chợ', icon: 'bag', end: false, badge: 'market' },
  { to: '/profile', label: 'Hồ sơ', icon: 'user', end: false },
];

const poll = { refetchInterval: 30_000, refetchOnWindowFocus: true };

export function BottomNav() {
  // Partner's new posts + comments since I last opened the Story tab.
  const stories = useQuery({ queryKey: STORY_UNREAD_KEY, queryFn: storiesApi.unread, ...poll });
  // Answered redemption requests + new items in the partner's shop since I last opened the Market tab.
  const market = useQuery({ queryKey: MARKET_UNREAD_KEY, queryFn: marketApi.unread, ...poll });
  const counts: Record<BadgeKey, number> = { stories: stories.data?.count ?? 0, market: market.data?.count ?? 0 };

  return (
    <nav className="bottom-nav" aria-label="Điều hướng chính">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) => `bottom-nav__tab${isActive ? ' is-active' : ''}`}
        >
          {({ isActive }) => {
            const n = tab.badge ? counts[tab.badge] : 0;
            const badge = !isActive && n > 0;
            return (
              <>
                <span className="bottom-nav__pill">
                  <Icon name={tab.icon} size={22} strokeWidth={isActive ? 2.4 : 2} />
                  {badge && (
                    <span className="count-badge count-badge--nav" aria-hidden="true">
                      {n > 9 ? '9+' : n}
                    </span>
                  )}
                </span>
                <span>{tab.label}</span>
                {badge && <span className="visually-hidden">, {n} mới</span>}
              </>
            );
          }}
        </NavLink>
      ))}
    </nav>
  );
}
