import { ScheduleAt, Timestamp } from 'spacetimedb';
import { SenderError, t } from 'spacetimedb/server';
import spacetimedb, { taskLease } from './schema';
import { MESSAGE_KINDS, ROLES, WORKER_ROLES, parseRefs, requireEvidence, requireId, requireOwner, requireRole, requireRun,
  requireSymbol, requireText, requireRunAccess, type Ctx, type Role } from './access';

export default spacetimedb;
export * from './records';
export * from './paper-safety';
export { grantRunAccess, revokeRunAccess, grantAccountAccess, revokeAccountAccess, configureRunLimits,
  addRiskPolicy, recordMarketClock, recordDecisionInput, beginInference, finishInference } from './controls';
export * from './views';

const LEASE_MICROS = 60_000_000n;

function scheduleLease(ctx: Ctx, taskId: string, version: bigint, until: Timestamp): void {
  ctx.db.taskLease.insert({ id: 0n, scheduledAt: ScheduleAt.time(until.microsSinceUnixEpoch), taskId, version });
}

export const init = spacetimedb.init(ctx => {
  ctx.db.ownerConfig.insert({ key: 'owner', owner: ctx.sender });
});

export const grantAgent = spacetimedb.reducer(
  { identity: t.identity(), role: t.string() },
  (ctx, { identity, role }) => {
    requireOwner(ctx);
    if (!ROLES.includes(role as Role)) throw new SenderError('Unknown role');
    const existing = ctx.db.agent.identity.find(identity);
    const row = { identity, role, status: 'offline', lastSeen: ctx.timestamp };
    if (existing) ctx.db.agent.identity.update(row);
    else ctx.db.agent.insert(row);
  }
);

export const revokeAgent = spacetimedb.reducer({ identity: t.identity() }, (ctx, { identity }) => {
  requireOwner(ctx);
  const existing = ctx.db.agent.identity.find(identity);
  if (existing) ctx.db.agent.identity.update({ ...existing, role: 'revoked', status: 'offline', lastSeen: ctx.timestamp });
});

export const heartbeat = spacetimedb.reducer(ctx => {
  requireRole(ctx, ROLES);
  const existing = ctx.db.agent.identity.find(ctx.sender)!;
  ctx.db.agent.identity.update({ ...existing, status: 'online', lastSeen: ctx.timestamp });
});

export const createRun = spacetimedb.reducer(
  { id: t.string(), goal: t.string() },
  (ctx, { id, goal }) => {
    requireRole(ctx, ['operator']);
    requireId(id); requireText(goal, 'Goal');
    if (ctx.db.run.id.find(id)) throw new SenderError('Run already exists');
    ctx.db.run.insert({ id, goal, status: 'active', createdAt: ctx.timestamp });
  }
);

export const setRunStatus = spacetimedb.reducer(
  { id: t.string(), status: t.string() },
  (ctx, { id, status }) => {
    requireRole(ctx, ['operator']);
    if (!['active', 'paused', 'closed'].includes(status)) throw new SenderError('Invalid run status');
    const existing = ctx.db.run.id.find(id);
    if (!existing) throw new SenderError('Run not found');
    if (existing.status === 'closed') throw new SenderError('Closed run cannot be reopened');
    ctx.db.run.id.update({ ...existing, status });
  }
);

export const createTask = spacetimedb.reducer(
  { id: t.string(), runId: t.string(), symbol: t.string(), kind: t.string(), objective: t.string(),
    role: t.string(), dependsOn: t.string() },
  (ctx, { id, runId, symbol, kind, objective, role, dependsOn }) => {
    requireRole(ctx, ['operator', 'coordinator']);
    requireId(id); requireSymbol(symbol); requireText(kind, 'Kind', 64); requireText(objective, 'Objective');
    requireRun(ctx, runId);
    if (role && !WORKER_ROLES.includes(role as Role)) throw new SenderError('Task role must be coordinator, analyst, or skeptic');
    if (dependsOn) {
      const dependency = ctx.db.task.id.find(dependsOn);
      if (!dependency || dependency.runId !== runId) throw new SenderError('Dependency is not in run');
      if (dependency.symbol !== symbol) throw new SenderError('Dependency is for a different symbol');
    }
    const existing = ctx.db.task.id.find(id);
    if (existing) {
      // Identical retries are accepted so a coordinator can safely re-issue after reconnecting.
      if (existing.runId === runId && existing.symbol === symbol && existing.kind === kind &&
          existing.objective === objective && existing.role === role && existing.dependsOn === dependsOn) return;
      throw new SenderError('Task already exists');
    }
    ctx.db.task.insert({ id, runId, symbol, kind, objective, status: 'open', assignee: undefined,
      leaseUntil: undefined, version: 0n, result: '', createdAt: ctx.timestamp, updatedAt: ctx.timestamp,
      role, dependsOn });
  }
);

export const claimTask = spacetimedb.reducer(
  { id: t.string(), expectedVersion: t.u64() },
  (ctx, { id, expectedVersion }) => {
    requireRole(ctx, ['coordinator', 'analyst', 'skeptic']);
    const existing = ctx.db.task.id.find(id);
    if (!existing) throw new SenderError('Task not found');
    requireRun(ctx, existing.runId);
    if (existing.version !== expectedVersion || existing.status !== 'open') throw new SenderError('Task already claimed or changed');
    if (existing.role && ctx.db.agent.identity.find(ctx.sender)?.role !== existing.role) throw new SenderError(`Task requires role ${existing.role}`);
    if (existing.dependsOn && ctx.db.task.id.find(existing.dependsOn)?.status !== 'completed') throw new SenderError('Task dependency is not completed');
    const until = new Timestamp(ctx.timestamp.microsSinceUnixEpoch + LEASE_MICROS);
    const version = existing.version + 1n;
    ctx.db.task.id.update({ ...existing, status: 'claimed', assignee: ctx.sender, leaseUntil: until,
      version, updatedAt: ctx.timestamp });
    scheduleLease(ctx, id, version, until);
  }
);

export const renewTaskLease = spacetimedb.reducer({ id: t.string() }, (ctx, { id }) => {
  requireRole(ctx, ['coordinator', 'analyst', 'skeptic']);
  const existing = ctx.db.task.id.find(id);
  if (existing) requireRunAccess(ctx, existing.runId);
  if (!existing || existing.status !== 'claimed' || !existing.assignee?.equals(ctx.sender)) throw new SenderError('Task not owned');
  if (!existing.leaseUntil || existing.leaseUntil.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('Lease expired');
  const until = new Timestamp(ctx.timestamp.microsSinceUnixEpoch + LEASE_MICROS);
  const version = existing.version + 1n;
  ctx.db.task.id.update({ ...existing, leaseUntil: until, version, updatedAt: ctx.timestamp });
  scheduleLease(ctx, id, version, until);
});

export const completeTask = spacetimedb.reducer(
  { id: t.string(), result: t.string() },
  (ctx, { id, result }) => {
    requireRole(ctx, ['coordinator', 'analyst', 'skeptic']);
    requireText(result, 'Result');
    const existing = ctx.db.task.id.find(id);
    if (existing?.status === 'completed' && existing.assignee?.equals(ctx.sender) && existing.result === result) return;
    if (existing) requireRunAccess(ctx, existing.runId);
  if (!existing || existing.status !== 'claimed' || !existing.assignee?.equals(ctx.sender)) throw new SenderError('Task not owned');
    if (!existing.leaseUntil || existing.leaseUntil.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('Lease expired');
    ctx.db.task.id.update({ ...existing, status: 'completed', result, leaseUntil: undefined,
      version: existing.version + 1n, updatedAt: ctx.timestamp });
  }
);

export const failTask = spacetimedb.reducer(
  { id: t.string(), reason: t.string() },
  (ctx, { id, reason }) => {
    requireRole(ctx, ['coordinator', 'analyst', 'skeptic']);
    requireText(reason, 'Reason');
    const existing = ctx.db.task.id.find(id);
    if (existing?.status === 'failed' && existing.assignee?.equals(ctx.sender) && existing.result === reason) return;
    if (existing) requireRunAccess(ctx, existing.runId);
  if (!existing || existing.status !== 'claimed' || !existing.assignee?.equals(ctx.sender)) throw new SenderError('Task not owned');
    if (!existing.leaseUntil || existing.leaseUntil.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('Lease expired');
    ctx.db.task.id.update({ ...existing, status: 'failed', result: reason, leaseUntil: undefined,
      version: existing.version + 1n, updatedAt: ctx.timestamp });
  }
);

export const expireTaskLease = spacetimedb.reducer(
  { onSchedule: taskLease }, { arg: taskLease.rowType },
  (ctx, { arg }) => {
    const existing = ctx.db.task.id.find(arg.taskId);
    if (!existing || existing.status !== 'claimed' || existing.version !== arg.version) return;
    if (!existing.leaseUntil || existing.leaseUntil.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch) return;
    ctx.db.task.id.update({ ...existing, status: 'open', assignee: undefined, leaseUntil: undefined,
      version: existing.version + 1n, updatedAt: ctx.timestamp });
  }
);

export const postMessage = spacetimedb.reducer(
  { id: t.string(), runId: t.string(), taskId: t.string(), symbol: t.string(), recipientRole: t.string(),
    kind: t.string(), body: t.string(), evidenceRef: t.string() },
  (ctx, { id, runId, taskId, symbol, recipientRole, kind, body, evidenceRef }) => {
    requireRole(ctx, ['operator', 'coordinator', 'analyst', 'skeptic', 'ingestor', 'risk']);
    requireId(id); requireRun(ctx, runId); requireText(body, 'Body');
    if (!MESSAGE_KINDS.includes(kind)) throw new SenderError(`Kind must be one of: ${MESSAGE_KINDS.join(', ')}`);
    if (recipientRole && !ROLES.includes(recipientRole as Role)) throw new SenderError('Unknown recipient role');
    if (symbol) requireSymbol(symbol);
    if (taskId) {
      const linkedTask = ctx.db.task.id.find(taskId);
      if (linkedTask?.runId !== runId) throw new SenderError('Task is not in run');
      if (symbol && linkedTask.symbol !== symbol) throw new SenderError('Task is for a different symbol');
    }
    requireEvidence(ctx, parseRefs(evidenceRef), symbol, ['source', 'fact', 'thesis', 'market_observation'], runId);
    const existing = ctx.db.message.id.find(id);
    if (existing) {
      if (existing.sender.equals(ctx.sender) && existing.body === body && existing.runId === runId &&
          existing.taskId === taskId && existing.kind === kind && existing.evidenceRef === evidenceRef &&
          existing.symbol === symbol && existing.recipientRole === recipientRole) return;
      throw new SenderError('Message ID already used');
    }
    ctx.db.message.insert({ id, runId, taskId, symbol, recipientRole, sender: ctx.sender, kind, body, evidenceRef,
      createdAt: ctx.timestamp });
  }
);
