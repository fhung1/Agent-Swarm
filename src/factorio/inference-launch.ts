import { usdToMicros } from '../agents/spend-pricing.ts';
import { FACTORIO_RUN_SPEND_CAP_USD, FACTORIO_SPEND_PRICE_VERSION } from './run-spend.ts';

export interface InferenceLaunchInput {
  /** Zero disables call-count limits; the shared spend guard and run deadline still apply. */
  runId: string; actorIds: number[]; provider: string; model: string; actorModel?: string; maxCalls: number; runMs: number;
  orchestratorMaxCalls?: number; mode?: 'smoke' | 'production'; maxRunSpendUsd?: string;
}
export function inferenceLaunchPlan(input: InferenceLaunchInput) {
  if (!/^[a-z0-9_.-]{1,36}$/.test(input.runId)) throw Error('Invalid run ID');
  const actorModel = input.actorModel ?? input.model;
  if (input.provider !== 'codex' || input.model !== 'gpt-6-astra' || !['gpt-6-astra', 'gpt-6-luna'].includes(actorModel)) {
    throw Error('The Factorio demo requires OpenAI Codex with a gpt-6-astra overseer and gpt-6-astra or gpt-6-luna actors');
  }
  if (input.actorIds.length !== 5 || new Set(input.actorIds).size !== 5 || input.actorIds.some(id => !Number.isSafeInteger(id) || id < 1 || id > 2147483647)) throw Error('Exactly five distinct game actors required');
  const mode = input.mode ?? (input.maxCalls > 0 && input.maxCalls <= 3 ? 'smoke' : 'production');
  if (!['smoke', 'production'].includes(mode) || !Number.isSafeInteger(input.maxCalls) || input.maxCalls < 0 || input.maxCalls > 1000 || !Number.isSafeInteger(input.runMs) || input.runMs < 1000 || input.runMs > 3600000) throw Error('Set call counts to zero for unlimited or a valid bounded count, and provide a run duration');
  const orchestratorMaxCalls = input.orchestratorMaxCalls ?? (input.maxCalls === 0 ? 0 : Math.max(5, Math.min(input.maxCalls, 120)));
  if (!Number.isSafeInteger(orchestratorMaxCalls) || orchestratorMaxCalls < 0 || (orchestratorMaxCalls > 0 && orchestratorMaxCalls < 5) || orchestratorMaxCalls > 1000) throw Error('The Astra overseer needs at least five calls to create one subtask per actor, or zero for unlimited');
  const maxRunSpendUsd = input.maxRunSpendUsd ?? FACTORIO_RUN_SPEND_CAP_USD;
  const capMicros = usdToMicros(maxRunSpendUsd);
  if (capMicros < 1n || capMicros > usdToMicros(FACTORIO_RUN_SPEND_CAP_USD)) throw Error('Factorio run spend cap must be greater than zero and at most $400');
  if (mode === 'smoke' && (input.maxCalls === 0 || input.maxCalls > 3)) throw Error('Smoke runs require one to three calls per actor');
  if (mode === 'production' && (input.maxCalls !== 0 || orchestratorMaxCalls !== 0)) throw Error('Production runs require unlimited calls for both actors and overseer; set both call counts to zero');
  const actorIds = input.actorIds.slice().sort((a, b) => a - b);
  const actorCallLimit = input.maxCalls === 0 ? null : input.maxCalls;
  const overseerCallLimit = orchestratorMaxCalls === 0 ? null : orchestratorMaxCalls;
  return { ...input, maxCalls: actorCallLimit, orchestratorMaxCalls: overseerCallLimit, actorIds, mode, actorModel, actorEffort: 'low' as const,
    maxRunSpendUsd, spendPriceVersion: FACTORIO_SPEND_PRICE_VERSION,
    totalCallLimit: actorCallLimit === null || overseerCallLimit === null ? null : actorCallLimit * 5 + overseerCallLimit,
    orchestrator: { sender: `${input.runId}-orchestrator`, model: input.model, effort: 'high' as const, maxCalls: overseerCallLimit },
    workers: actorIds.map((actorId, i) => ({
    actorId, index: i + 1, sender: `${input.runId}-agent-${i + 1}`, taskId: `${input.runId}.subtask-orchestrator-${i + 1}`,
  })) };
}
