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
  const existing = ctx.db.run.id.find(runId);
  if (!existing || existing.status !== 'active') throw new SenderError('Run is not active');
}
