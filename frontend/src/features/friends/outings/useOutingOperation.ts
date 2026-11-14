import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, assertCurrentSession, currentAccessEpoch } from '../../../lib/apiClient';
import { tokenStore } from '../../../lib/tokenStore';
import { OUTINGS_KEY, outingKey } from './api';
import type { MutationMeta, OutingResult } from './types';

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
  async function run(revision: number, send: (meta: MutationMeta) => Promise<OutingResult>): Promise<OutingResult | undefined> {
    // An old form must never retry its captured payload using a new account's tokens.
    if (!isCurrentSession() || busyRef.current || stale) return;
    if (!attempt.current) attempt.current = { meta: { operationId: crypto.randomUUID(), expectedRevision: baseRevision.current ?? revision }, send };
    busyRef.current = true; setBusy(true); setError('');
    const accessEpoch = currentAccessEpoch();
    try {
      assertCurrentSession(generation);
      const result = await attempt.current.send(attempt.current.meta);
      // Transport checks alone cannot protect this later cache continuation.
      if (!isCurrentSession()) return;
      assertCurrentSession(generation);
      if (accessEpoch === currentAccessEpoch()) qc.setQueryData(outingKey(result.outing.id), result.outing);
      else void qc.invalidateQueries({ queryKey: outingKey(result.outing.id) });
      void qc.invalidateQueries({ queryKey: OUTINGS_KEY });
      attempt.current = null; setUncertain(false); setStale(false);
      return result;
    } catch (err) {
      if (!isCurrentSession()) return;
      const unknown = !(err instanceof ApiRequestError) || err.status >= 500 || err.status === 408;
      setUncertain(unknown);
      const conflict = err instanceof ApiRequestError && err.status === 409;
      setStale(err instanceof ApiRequestError && err.code === 'OUTING_REVISION_CONFLICT');
      if (id && conflict) await qc.invalidateQueries({ queryKey: outingKey(id) });
      if (!isCurrentSession()) return;
      setError(unknown ? 'Chưa rõ yêu cầu đã được lưu chưa. Giữ nguyên nội dung và thử lại cùng yêu cầu để tránh ghi hai lần.' : err instanceof Error ? err.message : 'Không lưu được. Vui lòng thử lại.');
      // A definite rejection cannot have committed this operation. A 409 stays until explicit review/reset.
      if (!unknown && !(err instanceof ApiRequestError && err.code === 'OUTING_REVISION_CONFLICT')) attempt.current = null;
    } finally {
      busyRef.current = false;
      if (isCurrentSession()) setBusy(false);
    }
  }
  function reset() {
    if (!isCurrentSession() || busyRef.current || uncertain) return;
    attempt.current = null; baseRevision.current = draftRevision; setStale(false); setError('');
  }
  // Callers must check again after awaiting run(), before closing a sheet or navigating.
  return { run, busy, error, uncertain, stale, reset, isCurrentSession, locked: busy || uncertain || stale };
}
export type OutingOperation = ReturnType<typeof useOutingOperation>;
