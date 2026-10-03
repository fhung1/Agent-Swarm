import { SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import spacetimedb from './schema';

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
export type Role = 'operator' | 'coordinator' | 'analyst' | 'skeptic' | 'ingestor' | 'market_data' | 'risk' | 'executor';
export const ROLES: Role[] = ['operator', 'coordinator', 'analyst', 'skeptic', 'ingestor', 'market_data', 'risk', 'executor'];

export function requireId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new SenderError('Invalid ID');
}

export function requireText(value: string, label: string, max = 4096): void {
  if (!value.trim() || value.length > max) throw new SenderError(`${label} must be 1-${max} characters`);
}

export function requireOwner(ctx: Ctx): void {
  const config = ctx.db.ownerConfig.key.find('owner');
  if (!config || !config.owner.equals(ctx.sender)) throw new SenderError('Owner required');
}

export function requireRole(ctx: Ctx, roles: Role[]): void {
  const worker = ctx.db.agent.identity.find(ctx.sender);
  if (!worker || !roles.includes(worker.role as Role)) throw new SenderError('Role not authorized');
}

export function requireRun(ctx: Ctx, runId: string): void {
  requireRunAccess(ctx, runId);
  const existing = ctx.db.run.id.find(runId);
  if (!existing || existing.status !== 'active') throw new SenderError('Run is not active');
}

export const WORKER_ROLES: Role[] = ['coordinator', 'analyst', 'skeptic'];
export const MESSAGE_KINDS = ['observation', 'claim', 'question', 'challenge', 'answer', 'result', 'decision', 'status'];

export function requireSymbol(value: string): void {
  if (!/^[A-Z][A-Z0-9.-]{0,15}$/.test(value)) throw new SenderError('Invalid symbol');
}

// Evidence references are comma-separated IDs of source, fact, thesis, or market-observation rows.
export function parseRefs(value: string): string[] {
  if (value.length > 4096) throw new SenderError('Evidence references too long');
  if (!value.trim()) return [];
  const refs = value.split(',').map(ref => ref.trim());
  if (refs.length > 50) throw new SenderError('Too many evidence references');
  refs.forEach(requireId);
  return refs;
}

export function requireEvidence(
  ctx: Ctx, refs: string[], symbol: string, kinds: ('source' | 'fact' | 'thesis' | 'market_observation')[], runId?: string,
): void {
  for (const ref of refs) {
    const source = kinds.includes('source') ? ctx.db.source.id.find(ref) : undefined;
    const fact = kinds.includes('fact') ? ctx.db.fact.id.find(ref) : undefined;
    const thesis = kinds.includes('thesis') ? ctx.db.thesis.id.find(ref) : undefined;
    const observation = kinds.includes('market_observation') ? ctx.db.marketObservation.id.find(ref) : undefined;
    const found = source ?? fact ?? thesis ?? observation;
    if (!found) throw new SenderError(`Unknown evidence reference ${ref}`);
    if (symbol && found.symbol !== symbol) throw new SenderError(`Evidence ${ref} is for a different symbol`);
    const sourceRun = source?.runId ?? thesis?.runId ?? (fact ? ctx.db.source.id.find(fact.sourceId)?.runId : undefined);
    if (runId && sourceRun && sourceRun !== runId) throw new SenderError(`Evidence ${ref} is from a different run`);
    const dated = source?.asOf ?? observation?.asOf;
    if (dated && dated.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('Future-dated evidence');
  }
}

export function requireRunAccess(ctx: Ctx, runId: string): void {
  if (ctx.db.agent.identity.find(ctx.sender)?.role === 'operator') return;
  if (!ctx.db.runAccess.id.find(`${ctx.sender.toHexString()}:${runId}`)) throw new SenderError('Run access required');
}
export function requireAccountAccess(ctx: Ctx, accountId: string): void {
  if (!ctx.db.accountAccess.id.find(`${ctx.sender.toHexString()}:${accountId}`)) throw new SenderError('Account access required');
}
