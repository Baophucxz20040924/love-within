type Candidate = { path: string; load: () => Promise<unknown> };

type NetworkInformation = { saveData?: boolean; effectiveType?: string };

function allowed(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof navigator === 'undefined') return false;
  const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  return document.visibilityState === 'visible' && navigator.onLine !== false && !connection?.saveData
    && !['slow-2g', '2g', '3g'].includes(connection?.effectiveType ?? '');
}

function sameRoute(a: string, b: string): boolean {
  const normalize = (path: string) => path.replace(/\/+$/, '').toLowerCase() || '/';
  return normalize(a) === normalize(b);
}

/** Schedule at most two selected routes for this shell lifetime. Never retries a gated batch. */
export function scheduleRoutePrefetch(candidates: readonly Candidate[], currentPath: () => string): () => void {
  if (!allowed()) return () => {};
  const queue = candidates.slice(0, 2).filter(candidate => !sameRoute(candidate.path, currentPath()));
  let cancelled = false;
  let cancelPending: (() => void) | undefined;

  const scheduleNext = () => {
    if (cancelled || !queue.length || !allowed()) return;
    const run = () => {
      cancelPending = undefined;
      if (cancelled || !allowed()) return;
      const candidate = queue.shift();
      if (!candidate) return;
      // A navigation may have reached this route since the batch was selected.
      if (sameRoute(candidate.path, currentPath())) {
        scheduleNext();
        return;
      }
      // Handle both rejected promises and synchronous loader exceptions.
      try {
        void Promise.resolve(candidate.load()).catch(() => undefined).then(scheduleNext);
      } catch {
        scheduleNext();
      }
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(run, { timeout: 5000 });
      cancelPending = () => window.cancelIdleCallback(id);
    } else {
      const id = window.setTimeout(run, 2000);
      cancelPending = () => window.clearTimeout(id);
    }
  };

  scheduleNext();
  return () => { cancelled = true; cancelPending?.(); cancelPending = undefined; };
}
