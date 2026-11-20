import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { isAppLocked, subscribeAppLock } from '../appLock/store';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { tokenStore } from '../../lib/tokenStore';
import { advanceAccessEpoch, withRequestDeadline } from '../../lib/apiClient';
import type { Domain } from './parser';
import { DomainBatch, invalidateDomains, needsMe, revokeDomains, scopeDomains, verifyScope } from './invalidation';
import { setVerification } from './verification';
import { RealtimeStream } from './stream';

/** Foreground hints only; REST remains authoritative and existing polling remains enabled. */
export function RealtimeSync() {
  const { isAuthenticated, me, space, refreshMe, revokeMe, verifyMe } = useAuth();
  const qc = useQueryClient();
  const locked = useSyncExternalStore(subscribeAppLock, isAppLocked);
  const [resumeVersion, setResumeVersion] = useState(0);
  const [eligible, setEligible] = useState(() => document.visibilityState === 'visible' && navigator.onLine);
  const generation = tokenStore.generation();
  const userId = me?.user.id;

  useLayoutEffect(() => {
    let active = true;
    let previous = eligible;
    const update = () => {
      if (!active) return;
      const next = document.visibilityState === 'visible' && navigator.onLine;
      if (next === previous) return;
      previous = next;
      if (isAuthenticated && userId && tokenStore.isCurrent(generation) && tokenStore.get()) setVerification('checking');
      setEligible(next);
      if (next) setResumeVersion(value => value + 1);
    };
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [eligible, generation, isAuthenticated, userId]);

  useLayoutEffect(() => {
    // Every branch owns the document-level verification mask, including paused sessions.
    // Cleanup runs before a replacement effect; an admin shell must never inherit this mask.
    const clearVerification = () => setVerification('clear');
    if (!isAuthenticated || !userId || !tokenStore.get()) { clearVerification(); return clearVerification; }
    if (locked || !eligible) { setVerification('checking'); return clearVerification; }
    let active = true;
    let verificationId = 0;
    let verifying = false;
    const pendingDirty = new Set<Domain>();
    let controller: AbortController | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const valid = () => active && !isAppLocked() && tokenStore.isCurrent(generation) && document.visibilityState === 'visible' && navigator.onLine;
    const batch = new DomainBatch((domains) => {
      if (!valid()) return;
      if (verifying) { domains.forEach(domain => pendingDirty.add(domain)); return; }
      invalidateDomains(qc, domains, space);
      if (space === 'friends' && domains.includes('account')) invalidateDomains(qc, ['friend-profile']);
      if (needsMe(domains)) void refreshMe();
    });
    const reconcileAccess = (attempt = 0, supersede = false, alreadyRevoked = false) => {
      // Initial REST and SSE ready describe the same boundary. Coalesce BEFORE fencing writes.
      if (!valid() || (verifying && !supersede)) return;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      controller?.abort();
      const round = new AbortController();
      controller = round;
      const id = ++verificationId;
      const current = () => valid() && id === verificationId && !round.signal.aborted;
      verifying = true;
      batch.flush();
      pendingDirty.clear(); // The full pass below covers hints already received.
      setVerification('checking');
      if (!alreadyRevoked) advanceAccessEpoch();
      void withRequestDeadline(20_000, round.signal, async signal => {
        const fresh = () => current() && !signal?.aborted;
        const [meOk, queriesOk] = await Promise.all([verifyMe(signal), verifyScope(qc, space, fresh)]);
        if (!fresh() || !meOk || !queriesOk) return false;
        // At most two trailing domain passes, not an unbounded series of full auth rounds.
        for (let pass = 0; pendingDirty.size && pass < 2; pass++) {
          const domains = [...pendingDirty];
          pendingDirty.clear();
          const [identityOk, scopeOk] = await Promise.all([
            needsMe(domains) ? verifyMe(signal) : Promise.resolve(true),
            verifyScope(qc, space, fresh, domains),
          ]);
          if (!fresh() || !identityOk || !scopeOk) return false;
        }
        return fresh() && pendingDirty.size === 0;
      }).catch(() => false).then(ok => {
        if (!current()) return;
        if (ok) {
          verifying = false;
          setVerification('clear', undefined, { generation, userId, space });
        } else {
          round.abort(); // Fence late work before offering retry; never log out on timeout.
          if (attempt < 2) retryTimer = setTimeout(() => reconcileAccess(attempt + 1, true), 1000 * 2 ** attempt);
          else setVerification('failed', () => reconcileAccess(0, true));
        }
      });
    };
    const stream = new RealtimeStream(space, (event) => {
      if (!valid()) return;
      if (event.type === 'ready') {
        reconcileAccess();
      } else if (event.type === 'access') {
        setVerification('checking');
        const domains = event.domains.length ? event.domains : scopeDomains(space);
        revokeMe(space === 'couple' && domains.some((d) => d === 'couple' || d === 'pairing' || d === 'account'));
        revokeDomains(qc, space, domains);
        reconcileAccess(0, true, true);
      } else if (verifying) {
        event.domains.forEach(domain => pendingDirty.add(domain));
      } else {
        batch.add(event.domains);
      }
    }, () => { if (valid() && !verifying && document.visibilityState === 'visible' && navigator.onLine) reconcileAccess(); });
    // Resume/online resync does not depend on the streaming endpoint being reachable.
    reconcileAccess();
    stream.start();
    return () => {
      active = false; verificationId++;
      controller?.abort();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      batch.clear(); stream.stop();
      clearVerification();
    };
  }, [eligible, locked, resumeVersion, generation, isAuthenticated, qc, refreshMe, revokeMe, verifyMe, space, userId]);
  return null;
}
