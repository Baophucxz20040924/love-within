import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, assertCurrentSession, currentAccessEpoch } from '../../../lib/apiClient';
import { tokenStore } from '../../../lib/tokenStore';
import { appLockEpoch, isAppLockCurrent } from '../../appLock/store';
import { OUTINGS_KEY, outingKey } from './api';
import type { MutationMeta, OutingResult } from './types';

const uncertainMessage = 'Chưa rõ yêu cầu đã được lưu chưa. Giữ nguyên nội dung và thử lại cùng yêu cầu để tránh ghi hai lần.';
type CurrentOutingResult = OutingResult & { isCurrent: () => boolean };

/** A submitted payload and key remain immutable until a definite outcome. Never replay a new key after a lost response. */
export function useOutingOperation(id?: string, draftRevision?: number) {
  const qc = useQueryClient();
  const generation = useRef(tokenStore.generation()).current;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrentSession = () => mounted.current && tokenStore.isCurrent(generation);
  const attempt = useRef<{ meta: MutationMeta; send: (meta: MutationMeta) => Promise<OutingResult> } | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [stale, setStale] = useState(false);
  const baseRevision = useRef(draftRevision);
  async function run(revision: number, send: (meta: MutationMeta) => Promise<OutingResult>): Promise<CurrentOutingResult | undefined> {
    // Capture access per send/retry, not at mount: a retained draft remains usable after PIN grace.
    const accessEpoch = currentAccessEpoch(), lockEpoch = appLockEpoch();
    const isCurrent = () => isCurrentSession() && accessEpoch === currentAccessEpoch() && isAppLockCurrent(lockEpoch);
    if (!isCurrent() || busyRef.current || stale) return;
    if (!attempt.current) attempt.current = { meta: { operationId: crypto.randomUUID(), expectedRevision: baseRevision.current ?? revision }, send };
    busyRef.current = true; setBusy(true); setError('');
    const preserveUnknown = () => { setUncertain(true); setStale(false); setError(uncertainMessage); };
    try {
      assertCurrentSession(generation);
      const result = await attempt.current.send(attempt.current.meta);
      // Even a resolved transport promise can cross a conceal/resume before this continuation.
      if (!isCurrentSession()) return;
      if (!isCurrent()) { preserveUnknown(); return; }
      qc.setQueryData(outingKey(result.outing.id), result.outing);
      void qc.invalidateQueries({ queryKey: OUTINGS_KEY });
      attempt.current = null; setUncertain(false); setStale(false);
      // Callers check this exact attempt again after awaiting run(), before closing/navigating.
      return { ...result, isCurrent };
    } catch (err) {
      if (!isCurrentSession()) return;
      if (!isCurrent()) { preserveUnknown(); return; }
      const unknown = !(err instanceof ApiRequestError) || err.code === 'ACCESS_CHANGED' || err.status >= 500 || err.status === 408;
      setUncertain(unknown);
      const conflict = err instanceof ApiRequestError && err.status === 409;
      setStale(err instanceof ApiRequestError && err.code === 'OUTING_REVISION_CONFLICT');
      if (id && conflict) await qc.invalidateQueries({ queryKey: outingKey(id) });
      if (!isCurrentSession()) return;
      if (!isCurrent()) { preserveUnknown(); return; }
      setError(unknown ? uncertainMessage : err instanceof Error ? err.message : 'Không lưu được. Vui lòng thử lại.');
      // A definite rejection cannot have committed this operation. A 409 stays until explicit review/reset.
      if (!unknown && !(err instanceof ApiRequestError && err.code === 'OUTING_REVISION_CONFLICT')) attempt.current = null;
    } finally {
      busyRef.current = false;
      // Clearing busy/recording uncertainty is safe for a concealed retained tree; no success escapes.
      if (isCurrentSession()) setBusy(false);
    }
  }
  function reset() {
    if (!isCurrentSession() || !isAppLockCurrent(appLockEpoch()) || busyRef.current || uncertain) return;
    attempt.current = null; baseRevision.current = draftRevision; setStale(false); setError('');
  }
  return { run, busy, error, uncertain, stale, reset, locked: busy || uncertain || stale };
}
export type OutingOperation = ReturnType<typeof useOutingOperation>;
