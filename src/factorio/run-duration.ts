/** Persisted deadline 0 explicitly means no run-duration limit. */
export function deadlineFromDuration(runMs: number, now = Date.now()): number {
  if (!Number.isSafeInteger(runMs) || runMs < 0) throw Error('Invalid run duration');
  return runMs === 0 ? 0 : now + runMs;
}
export function runExpired(deadline: number, now = Date.now()): boolean {
  if (!Number.isSafeInteger(deadline) || deadline < 0) throw Error('Invalid run deadline');
  return deadline !== 0 && now >= deadline;
}
export function remainingRunMs(deadline: number, now = Date.now()): number {
  runExpired(deadline, now);
  return deadline === 0 ? Infinity : Math.max(0, deadline - now);
}
export function selectRunDeadline(runMs: number, saved: number | undefined, now = Date.now()): number {
  const requested = deadlineFromDuration(runMs, now);
  if (saved === undefined) return requested;
  if (runExpired(saved, now)) throw Error('Persisted run deadline has expired; refusing to extend this run');
  if ((saved === 0) !== (requested === 0)) throw Error('Run duration mode differs from saved state; explicit migration required');
  return saved === 0 ? 0 : Math.min(requested, saved);
}
