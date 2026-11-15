import { useLayoutEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { tokenStore } from '../../lib/tokenStore';
import { advanceAccessEpoch } from '../../lib/apiClient';
import { DomainBatch, invalidateDomains, needsMe, revokeDomains, scopeDomains, verifyScope } from './invalidation';
import { setVerification } from './verification';
import { RealtimeStream } from './stream';

/** Foreground hints only; REST remains authoritative and existing polling remains enabled. */
export function RealtimeSync() {
  const { isAuthenticated, me, space, refreshMe, revokeMe, verifyMe } = useAuth();
  const qc = useQueryClient();
  const [eligible, setEligible] = useState(() => document.visibilityState === 'visible' && navigator.onLine);
  const [resumeVersion, setResumeVersion] = useState(0);
  const generation = tokenStore.generation();
  const userId = me?.user.id;

  useLayoutEffect(() => {
    let previous = eligible;
    const update = () => {
      const next = document.visibilityState === 'visible' && navigator.onLine;
      if (next === previous) return;
      previous = next;
      if (isAuthenticated && userId && tokenStore.isCurrent(generation) && tokenStore.get()) setVerification('checking');
      setEligible(next);
      // Fast hidden/visible pairs may batch back to the original Boolean.
      if (next) setResumeVersion(value => value + 1);
    };
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [eligible, generation, isAuthenticated, userId]);

  useLayoutEffect(() => {
    if (!isAuthenticated || !userId || !tokenStore.get()) { setVerification('clear'); return; }
    if (!eligible) { setVerification('checking'); return; }
    let active = true;
    let verificationId = 0;
    let verifying = false;
    let pendingDirty = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const valid = () => active && tokenStore.isCurrent(generation) && document.visibilityState === 'visible' && navigator.onLine;
    const batch = new DomainBatch((domains) => {
      if (!valid()) return;
      if (verifying) { pendingDirty = true; return; }
      invalidateDomains(qc, domains, space);
      if (space === 'friends' && domains.includes('account')) invalidateDomains(qc, ['friend-profile']);
      if (needsMe(domains)) void refreshMe();
    });
    const reconcileAccess = (attempt = 0) => {
      if (!valid()) return;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      const id = ++verificationId;
      const current = () => valid() && id === verificationId;
      batch.clear();
      verifying = true;
      setVerification('checking');
      advanceAccessEpoch();
      void (async () => {
        const [meOk, queriesOk] = await Promise.all([verifyMe(), verifyScope(qc, space, current)]);
        if (!current()) return;
        if (meOk && queriesOk) {
          if (pendingDirty) { pendingDirty = false; reconcileAccess(); return; }
          verifying = false; setVerification('clear'); return;
        }
        if (attempt < 2) retryTimer = setTimeout(() => reconcileAccess(attempt + 1), 1000 * 2 ** attempt);
        else setVerification('failed', () => reconcileAccess());
      })().catch(() => { if (current()) setVerification('failed', () => reconcileAccess()); });
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
        reconcileAccess();
      } else if (verifying) {
        pendingDirty = true;
      } else {
        batch.add(event.domains);
      }
    }, () => { if (valid() && !verifying && document.visibilityState === 'visible' && navigator.onLine) reconcileAccess(); });
    // Resume/online resync does not depend on the streaming endpoint being reachable.
    reconcileAccess();
    stream.start();
    return () => { active = false; verificationId++; if (retryTimer !== undefined) clearTimeout(retryTimer); batch.clear(); stream.stop(); };
  }, [eligible, resumeVersion, generation, isAuthenticated, qc, refreshMe, revokeMe, verifyMe, space, userId]);
  return null;
}
