import { Suspense, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { BottomNav } from './BottomNav';
import { Loading } from './StatusViews';
import { prefetchPages } from '../app/lazyPages';
import { useApprovalSignals, useApprovals } from '../features/approvals/useApprovals';

/** Mobile-first shell: page content + fixed bottom navigation. */
export function AppLayout() {
  const { count } = useApprovals();
  useApprovalSignals(count);

  // Once the first screen is up, fetch the other pages' code while the browser is idle.
  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(prefetchPages, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = window.setTimeout(prefetchPages, 2000);
    return () => window.clearTimeout(t);
  }, []);

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
