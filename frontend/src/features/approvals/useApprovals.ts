import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { PROPOSAL_KEY, proposalsApi } from '../proposals/api';
import { WATER_PENDING_KEY, waterApi } from '../water/api';
import { MARKET_PENDING_KEY, marketApi } from '../market/api';
import { savingsNeedsRetry } from '../savings/api';
import type { PendingWater, Proposal, Redemption } from '../../lib/types';

/** How often approvals are re-checked while the app is visible (cheap: three small queries). */
const POLL_MS = 20_000;

export type ApprovalItem =
  | { type: 'water'; createdAt: string; water: PendingWater }
  | { type: 'proposal'; createdAt: string; proposal: Proposal }
  | { type: 'market'; createdAt: string; redemption: Redemption };

export function approvalKey(item: ApprovalItem): string {
  if (item.type === 'water') return `water:${item.water.id}`;
  if (item.type === 'proposal') return `proposal:${item.proposal.id}`;
  return `market:${item.redemption.id}`;
}

/**
 * Everything waiting on the couple, split into "needs my action" (incoming) and
 * "waiting on my partner" (outgoing). Shared by the bell, Home, Quests and /approvals —
 * React Query dedupes the requests.
 */
export function useApprovals() {
  const { me } = useAuth();
  const myId = me?.user.id;
  const enabled = Boolean(me?.user.coupleId);
  const common = { enabled, refetchInterval: POLL_MS, refetchOnWindowFocus: true };

  const proposals = useQuery({ queryKey: PROPOSAL_KEY, queryFn: proposalsApi.listPending, ...common });
  const water = useQuery({ queryKey: WATER_PENDING_KEY, queryFn: waterApi.pending, ...common });
  const market = useQuery({ queryKey: MARKET_PENDING_KEY, queryFn: marketApi.pending, ...common });

  const incoming: ApprovalItem[] = [];
  const outgoing: ApprovalItem[] = [];
  for (const w of water.data ?? []) {
    (w.userId === myId ? outgoing : incoming).push({ type: 'water', createdAt: w.createdAt, water: w });
  }
  for (const p of proposals.data ?? []) {
    const approvedByMe = myId ? p.approvals.includes(myId) : false;
    (approvedByMe && !savingsNeedsRetry(p) ? outgoing : incoming).push({ type: 'proposal', createdAt: p.createdAt, proposal: p });
  }
  for (const r of market.data ?? []) {
    // The seller answers the request; the buyer waits.
    (r.isBuyer ? outgoing : incoming).push({ type: 'market', createdAt: r.createdAt, redemption: r });
  }
  const byNewest = (a: ApprovalItem, b: ApprovalItem) => b.createdAt.localeCompare(a.createdAt);
  incoming.sort(byNewest);
  outgoing.sort(byNewest);

  return {
    incoming,
    outgoing,
    count: incoming.length,
    incomingWater: incoming.filter((i) => i.type === 'water').length,
    incomingMarket: incoming.filter((i) => i.type === 'market').length,
    isLoading: proposals.isLoading || water.isLoading || market.isLoading,
    isError: proposals.isError || water.isError || market.isError,
    refetch: () => Promise.all([proposals.refetch(), water.refetch(), market.refetch()]),
  };
}

/** Mirror the count in the tab title and (installed PWA) the home-screen icon badge. */
export function useApprovalSignals(count: number, brand = 'Love Within', approximate = false) {
  useEffect(() => {
    const badge = count > 0 ? `${count}${approximate ? '+' : ''}` : approximate ? '•' : '';
    document.title = badge ? `(${badge}) ${brand}` : brand;
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (count > 0) void nav.setAppBadge?.(count).catch(() => undefined);
    else if (approximate) void nav.setAppBadge?.().catch(() => undefined);
    else void nav.clearAppBadge?.().catch(() => undefined);
  }, [count, brand, approximate]);
}
