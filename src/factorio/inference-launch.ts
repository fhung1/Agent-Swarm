export interface InferenceLaunchInput {
  runId: string; actorIds: number[]; provider: string; model: string; maxCalls: number; runMs: number;
  orchestratorMaxCalls?: number; mode?: 'smoke' | 'production';
}
export function inferenceLaunchPlan(input: InferenceLaunchInput) {
  if (!/^[a-z0-9_.-]{1,36}$/.test(input.runId)) throw Error('Invalid run ID');
  if (!['claude', 'codex'].includes(input.provider) || input.model !== 'gpt-6-astra') throw Error('The Factorio demo requires the explicit gpt-6-astra model');
  if (input.actorIds.length !== 5 || new Set(input.actorIds).size !== 5 || input.actorIds.some(id => !Number.isSafeInteger(id) || id < 1 || id > 2147483647)) throw Error('Exactly five distinct game actors required');
  const mode = input.mode ?? (input.maxCalls <= 3 ? 'smoke' : 'production');
  if (!['smoke', 'production'].includes(mode) || !Number.isSafeInteger(input.maxCalls) || input.maxCalls < 1 || input.maxCalls > 1000 || !Number.isSafeInteger(input.runMs) || input.runMs < 1000 || input.runMs > 3600000) throw Error('Explicit bounded call count and run duration required');
  const orchestratorMaxCalls = input.orchestratorMaxCalls ?? Math.min(input.maxCalls, 120);
  if (!Number.isSafeInteger(orchestratorMaxCalls) || orchestratorMaxCalls < 1 || orchestratorMaxCalls > 1000) throw Error('Invalid orchestrator call limit');
  if (mode === 'smoke' && input.maxCalls > 3) throw Error('Smoke runs permit at most three calls per actor');
  if (mode === 'production' && input.maxCalls < 8) throw Error('Production demos require at least eight calls per actor');
  const actorIds = input.actorIds.slice().sort((a, b) => a - b);
  return { ...input, orchestratorMaxCalls, actorIds, mode, actorModel: input.model, actorEffort: 'low' as const,
    totalCallLimit: input.maxCalls * 5 + orchestratorMaxCalls,
    orchestrator: { sender: `${input.runId}-orchestrator`, model: input.model, effort: 'high' as const, maxCalls: orchestratorMaxCalls },
    workers: actorIds.map((actorId, i) => ({
    actorId, index: i + 1, sender: `${input.runId}-agent-${i + 1}`, taskId: `${input.runId}.production-${i + 1}`,
  })) };
}
