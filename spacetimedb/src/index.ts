import { ScheduleAt, Timestamp } from 'spacetimedb';
import { SenderError, t } from 'spacetimedb/server';
import spacetimedb, { taskLease } from './schema';
import { ROLES, requireId, requireOwner, requireRole, requireRun, requireText, type Ctx, type Role } from './access';

export default spacetimedb;
export * from './records';

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
  { id: t.string(), runId: t.string(), symbol: t.string(), kind: t.string(), objective: t.string() },
  (ctx, { id, runId, symbol, kind, objective }) => {
    requireRole(ctx, ['operator', 'coordinator']);
    requireId(id); requireText(kind, 'Kind', 64); requireText(objective, 'Objective');
    requireRun(ctx, runId);
    if (ctx.db.task.id.find(id)) throw new SenderError('Task already exists');
    ctx.db.task.insert({ id, runId, symbol, kind, objective, status: 'open', assignee: undefined,
      leaseUntil: undefined, version: 0n, result: '', createdAt: ctx.timestamp, updatedAt: ctx.timestamp });
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
  { id: t.string(), runId: t.string(), taskId: t.string(), kind: t.string(), body: t.string(), evidenceRef: t.string() },
  (ctx, { id, runId, taskId, kind, body, evidenceRef }) => {
    requireRole(ctx, ['operator', 'coordinator', 'analyst', 'skeptic', 'ingestor', 'risk']);
    requireId(id); requireRun(ctx, runId); requireText(kind, 'Kind', 64); requireText(body, 'Body');
    if (taskId && ctx.db.task.id.find(taskId)?.runId !== runId) throw new SenderError('Task is not in run');
    const existing = ctx.db.message.id.find(id);
    if (existing) {
      if (existing.sender.equals(ctx.sender) && existing.body === body && existing.runId === runId &&
          existing.taskId === taskId && existing.kind === kind && existing.evidenceRef === evidenceRef) return;
      throw new SenderError('Message ID already used');
    }
    ctx.db.message.insert({ id, runId, taskId, sender: ctx.sender, kind, body, evidenceRef, createdAt: ctx.timestamp });
  }
);
