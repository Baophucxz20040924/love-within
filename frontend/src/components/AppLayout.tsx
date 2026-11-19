import { Suspense, useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { BottomNav } from './BottomNav';
import { Loading } from './StatusViews';
import { couplePrefetchCandidates } from '../app/lazyPages';
import { scheduleRoutePrefetch } from '../lib/routePrefetch';
import { useApprovalSignals } from '../features/approvals/useApprovals';
import { useCoupleNotificationUnread } from '../features/notifications/useCoupleNotifications';

/** Mobile-first shell: page content + fixed bottom navigation. */
export function AppLayout() {
  const { data } = useCoupleNotificationUnread();
  useApprovalSignals(data?.notifications ?? 0, 'Love Within', data?.notificationsSaturated ?? false);

  const pathname = useLocation().pathname;
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  useEffect(() => scheduleRoutePrefetch(couplePrefetchCandidates, () => pathRef.current), []);

  return (
    <div className="app-shell">
      <main className="app-content">
        {/* Keeps the bottom nav visible while a page's code is loading. */}
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>
      <BottomNav />
    </div>
  );
}
