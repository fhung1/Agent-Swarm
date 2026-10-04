export interface InferenceLaunchInput {
  runId: string; actorIds: number[]; provider: string; model: string; maxCalls: number; runMs: number; mode?: 'smoke' | 'production';
}
export function inferenceLaunchPlan(input: InferenceLaunchInput) {
  if (!/^[a-z0-9_.-]{1,36}$/.test(input.runId)) throw Error('Invalid run ID');
  if (!['claude', 'codex'].includes(input.provider) || !input.model.trim() || input.model.length > 128) throw Error('Explicit provider/model required');
  if (input.actorIds.length !== 10 || new Set(input.actorIds).size !== 10 || input.actorIds.some(id => !Number.isSafeInteger(id) || id < 1 || id > 2147483647)) throw Error('Exactly ten distinct actor IDs required');
  const mode = input.mode ?? (input.maxCalls <= 3 ? 'smoke' : 'production');
  if (!['smoke', 'production'].includes(mode) || !Number.isSafeInteger(input.maxCalls) || input.maxCalls < 1 || input.maxCalls > 1000 || !Number.isSafeInteger(input.runMs) || input.runMs < 1000 || input.runMs > 3600000) throw Error('Explicit bounded call count and run duration required');
  if (mode === 'smoke' && input.maxCalls > 3) throw Error('Smoke runs permit at most three calls per actor');
  if (mode === 'production' && input.maxCalls < 8) throw Error('Production demos require at least eight calls per actor');
  const actorIds = input.actorIds.slice().sort((a, b) => a - b);
  return { ...input, mode, actorIds, totalCallLimit: input.maxCalls * 10, workers: actorIds.map((actorId, i) => ({
    actorId, index: i + 1, sender: `${input.runId}-agent-${i + 1}`, taskId: `${input.runId}.production-${i + 1}`,
  })) };
}
