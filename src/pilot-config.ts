import { z } from 'zod';
import { parseSwarmConfig, planProcesses, SwarmConfigSchema } from './swarm-plan.ts';
import { validatePolicy } from '../spacetimedb/src/risk.ts';

const positive = z.number().finite().positive();
const symbol = z.string().regex(/^[A-Z][A-Z0-9.-]{0,15}$/);
const policySchema = z.object({
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/),
  allowedSymbols: z.array(symbol).min(1).max(50),
  longOnly: z.literal(true), requireMarketOpen: z.literal(true),
  maxOrderNotional: positive, maxPositionNotional: positive, maxPortfolioNotional: positive,
  maxOpenOrders: positive.int(), maxDailyLoss: positive,
  maxQuoteAgeMs: positive.int(), maxAccountAgeMs: positive.int(),
  maxLimitDeviation: positive.max(1), approvalTtlMs: positive.int(), maxProposalAgeMs: positive.int(),
}).strict();
const schema = z.object({
  version: z.literal(1), mode: z.literal('paper'),
  // Review scheduling/evaluation are operator metadata until their board tasks land.
  holdingHorizonDays: positive.int().max(365),
  reviewEveryHours: positive.max(8760),
  benchmark: symbol,
  swarm: SwarmConfigSchema,
  policy: policySchema,
}).strict();
export type PilotConfig = z.infer<typeof schema>;

export function parsePilotConfig(json: string): PilotConfig {
  const c = schema.parse(JSON.parse(json));
  c.swarm = parseSwarmConfig(JSON.stringify(c.swarm));
  validatePolicy(c.policy);
  const s = c.swarm;
  if (!s.accountId.trim()) throw new Error('Set swarm.accountId to the intended paper account ID');
  if (!s.limits || !s.maxOrderNotional) throw new Error('Explicit run limits and maxOrderNotional are required');
  if (!s.research || s.research.evidence !== 'sec' || !s.marketData) throw new Error('SEC research and market data are required');
  for (const role of ['analyst', 'skeptic', 'coordinator'] as const) {
    const a = s.agents[role];
    if (!a.count || a.brain === 'rules' || !a.model?.trim()) throw new Error(`Set an explicit model and model brain for ${role}`);
  }
  if (s.agents.risk.count !== 1 || s.agents.executor.count !== 1) throw new Error('Pilot requires one risk worker and one executor');
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(s.research.symbols) || !unique(s.marketData.symbols)) throw new Error('Duplicate symbols are not allowed');
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(v => b.includes(v));
  if (!same(s.research.symbols, c.policy.allowedSymbols) || !same(s.marketData.symbols, c.policy.allowedSymbols)) {
    throw new Error('Research, market-data and risk-policy symbols must match');
  }
  if (s.maxOrderNotional > c.policy.maxOrderNotional || c.policy.maxOrderNotional > c.policy.maxPositionNotional ||
      c.policy.maxPositionNotional > c.policy.maxPortfolioNotional) throw new Error('Order, position and portfolio limits must be consistent');
  if (s.marketData.everySeconds * 1000 >= c.policy.maxQuoteAgeMs) throw new Error('Market-data interval must be shorter than quote freshness limit');
  if (c.reviewEveryHours > c.holdingHorizonDays * 24) throw new Error('Review cadence must fit the holding horizon');
  if (`${c.policy.version}.${s.runId}`.length > 128) throw new Error('Combined policy version and run ID exceed 128 characters');
  return c;
}

// Report names only, never values. This checks presence, not account identity, provider access or feed entitlement.
export function missingPilotEnvironment(c: PilotConfig, env: Record<string, string | undefined>): string[] {
  const required = new Set(planProcesses(c.swarm).flatMap(p => p.secrets));
  if (Object.values(c.swarm.agents).some(a => 'brain' in a && a.count && a.brain === 'claude')) {
    if (!env.ANTHROPIC_API_KEY?.trim() && !env.ANTHROPIC_AUTH_TOKEN?.trim()) required.add('ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN');
  }
  return [...required].filter(name => !env[name]?.trim()).sort();
}
