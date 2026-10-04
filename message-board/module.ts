import { Timestamp } from 'spacetimedb';
import { SenderError, schema, table, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';

// Shared local message-board framework. Development, games, and research use the
// same schema and reducers. Wire names dev_task/dev_message/file_lock are retained
// for compatibility with existing development histories and generated clients.
// Participant names are bound to the authenticated SpacetimeDB identity on registration.
export const DEFAULT_PARTICIPANT_LIMIT = 8;
export const MAX_PARTICIPANT_LIMIT = 8;

export function createMessageBoard(options: { taskInstruction?: string } = {}) {

  const session = table({ name: 'session', public: true }, {
    name: t.string().primaryKey(), tool: t.string(), focus: t.string(), lastSeen: t.timestamp(),
  });
  const sessionIdentity = table({ name: 'session_identity' }, {
    name: t.string().primaryKey(), identity: t.identity(),
  });
  const boardOperator = table({ name: 'board_operator' }, {
    key: t.string().primaryKey(), identity: t.identity(),
  });
  const boardConfig = table({ name: 'board_config', public: true }, {
    key: t.string().primaryKey(), participantLimit: t.u32(),
  });
  const taskColumns = () => ({
    id: t.string().primaryKey(), title: t.string(), details: t.string(), area: t.string(),
    status: t.string().index('btree'), createdBy: t.string(), assignee: t.string(), dependsOn: t.string(),
    result: t.string(), createdAt: t.timestamp(), updatedAt: t.timestamp(),
  });
  const devTask = table({ name: 'dev_task', public: true }, taskColumns());
  // Preserve dependency outcomes and recovery evidence outside the visible board.
  const archivedTask = table({ name: 'archived_task', public: true }, taskColumns());
  const devMessage = table({ name: 'dev_message', public: true }, {
    id: t.u64().primaryKey().autoInc(), sender: t.string(), recipient: t.string(), taskId: t.string(),
    body: t.string(), createdAt: t.timestamp(),
  });
  const fileLock = table({ name: 'file_lock', public: true }, {
    path: t.string().primaryKey(), holder: t.string(), taskId: t.string(), reason: t.string(),
    acquiredAt: t.timestamp(), expiresAt: t.timestamp(),
  });

  const taskPriority = table({ name: 'task_priority', public: true }, {
    taskId: t.string().primaryKey(), priority: t.string(), updatedBy: t.string(), updatedAt: t.timestamp(),
  });

  const spacetimedb = schema({ session, sessionIdentity, boardOperator, boardConfig, devTask, archivedTask, devMessage, fileLock, taskPriority });

  type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

  const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const TASK_STATUSES = ['open', 'claimed', 'done', 'blocked', 'cancelled'];
  const MAX_LOCK_MINUTES = 8 * 60;
  const MINUTE_MICROS = 60_000_000n;
  const taskInstruction = options.taskInstruction ?? '';

  function taskDetails(details: string): string {
    const result = !taskInstruction || details.includes(taskInstruction) ? details : `${details}${details ? '\n\n' : ''}${taskInstruction}`;
    requireText(result, 'Details', 8000, true);
    return result;
  }

  function requireText(value: string, label: string, max: number, allowEmpty = false): void {
    if ((!allowEmpty && !value.trim()) || value.length > max) {
      throw new SenderError(`${label} must be ${allowEmpty ? '0' : '1'}-${max} characters`);
    }
  }

  function requireSession(ctx: Ctx, name: string): void {
    if (!ctx.db.session.name.find(name)) throw new SenderError(`Unknown session ${name}; register it first`);
    const binding = ctx.db.sessionIdentity.name.find(name);
    if (!binding) throw new SenderError(`Session ${name} needs operator identity migration`);
    if (!binding.identity.equals(ctx.sender)) throw new SenderError(`Session ${name} belongs to another identity`);
  }

  function requireOperator(ctx: Ctx): void {
    const operator = ctx.db.boardOperator.key.find('operator');
    if (!operator || !operator.identity.equals(ctx.sender)) throw new SenderError('Board operator identity required');
  }

  function touch(ctx: Ctx, name: string): void {
    const existing = ctx.db.session.name.find(name)!;
    ctx.db.session.name.update({ ...existing, lastSeen: ctx.timestamp });
  }

  // Relative resource names: paths for development, world/chunk/entity scopes for games.
  // A trailing slash reserves a resource namespace.
  function normalizePath(path: string): string {
    const trimmed = path.trim().replace(/^\.\//, '');
    if (!trimmed || trimmed.length > 512 || trimmed.startsWith('/') || trimmed.split('/').includes('..')) {
      throw new SenderError('Lock path must be a relative resource name without ..');
    }
    return trimmed;
  }

  function overlaps(a: string, b: string): boolean {
    const covers = (dir: string, path: string) => dir.endsWith('/') && path.startsWith(dir);
    return a === b || covers(a, b) || covers(b, a);
  }

  function expired(ctx: Ctx, expiresAt: Timestamp): boolean {
    return expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch;
  }

  const register = spacetimedb.reducer(
    { name: t.string(), tool: t.string(), focus: t.string() },
    (ctx, { name, tool, focus }) => {
      if (!NAME.test(name)) throw new SenderError('Name must be lowercase letters, digits, dot, dash, or underscore');
      requireText(tool, 'Participant type', 64);
      requireText(focus, 'Focus', 512, true);
      const row = { name, tool, focus, lastSeen: ctx.timestamp };
      if (ctx.db.session.name.find(name)) {
        requireSession(ctx, name);
        ctx.db.session.name.update(row);
      } else {
        const limit = ctx.db.boardConfig.key.find('main')?.participantLimit ?? DEFAULT_PARTICIPANT_LIMIT;
        const count = [...ctx.db.session.iter()].length;
        if (count >= limit) throw new SenderError(`Participant limit reached (${count}/${limit}); only the board operator can change the limit (maximum ${MAX_PARTICIPANT_LIMIT})`);
        ctx.db.session.insert(row);
        ctx.db.sessionIdentity.insert({ name, identity: ctx.sender });
      }
    }
  );

  const setParticipantLimit = spacetimedb.reducer({ participantLimit: t.u32() }, (ctx, { participantLimit }) => {
    requireOperator(ctx);
    if (participantLimit < 1 || participantLimit > MAX_PARTICIPANT_LIMIT) {
      throw new SenderError(`Participant limit must be 1-${MAX_PARTICIPANT_LIMIT}`);
    }
    const count = [...ctx.db.session.iter()].length;
    if (participantLimit < count) throw new SenderError(`Participant limit cannot be lower than the current participant count (${count})`);
    const row = { key: 'main', participantLimit };
    if (ctx.db.boardConfig.key.find('main')) ctx.db.boardConfig.key.update(row);
    else ctx.db.boardConfig.insert(row);
  });

  // Call from the private server before exposing a new or migrated board remotely.
  const bootstrapBoardOperator = spacetimedb.reducer({}, ctx => {
    if (ctx.db.boardOperator.key.find('operator')) throw new SenderError('Board operator is already configured');
    ctx.db.boardOperator.insert({ key: 'operator', identity: ctx.sender });
  });

  const assignSessionIdentity = spacetimedb.reducer(
    { name: t.string(), identity: t.identity() }, (ctx, { name, identity }) => {
      requireOperator(ctx);
      if (!ctx.db.session.name.find(name)) throw new SenderError(`Unknown session ${name}`);
      const row = { name, identity };
      if (ctx.db.sessionIdentity.name.find(name)) ctx.db.sessionIdentity.name.update(row);
      else ctx.db.sessionIdentity.insert(row);
    }
  );

  const bindLegacySessions = spacetimedb.reducer({}, ctx => {
    requireOperator(ctx);
    for (const session of ctx.db.session.iter()) {
      if (!ctx.db.sessionIdentity.name.find(session.name)) {
        ctx.db.sessionIdentity.insert({ name: session.name, identity: ctx.sender });
      }
    }
  });

  const post = spacetimedb.reducer(
    { sender: t.string(), recipient: t.string(), taskId: t.string(), body: t.string() },
    (ctx, { sender, recipient, taskId, body }) => {
      requireSession(ctx, sender);
      if (recipient && !ctx.db.session.name.find(recipient)) throw new SenderError(`Unknown recipient ${recipient}`);
      if (taskId && !(ctx.db.devTask.id.find(taskId) ?? ctx.db.archivedTask.id.find(taskId))) throw new SenderError(`Unknown task ${taskId}`);
      requireText(body, 'Message', 8000);
      ctx.db.devMessage.insert({ id: 0n, sender, recipient, taskId, body, createdAt: ctx.timestamp });
      touch(ctx, sender);
    }
  );

  const createTask = spacetimedb.reducer(
    { name: t.string(), id: t.string(), title: t.string(), details: t.string(), area: t.string(), dependsOn: t.string() },
    (ctx, { name, id, title, details, area, dependsOn }) => {
      requireSession(ctx, name);
      if (!ID.test(id)) throw new SenderError('Invalid task ID');
      requireText(title, 'Title', 200); requireText(details, 'Details', 8000, true); requireText(area, 'Area', 512, true);
      if (dependsOn && !(ctx.db.devTask.id.find(dependsOn) ?? ctx.db.archivedTask.id.find(dependsOn))) throw new SenderError(`Unknown dependency ${dependsOn}`);
      if (ctx.db.devTask.id.find(id) || ctx.db.archivedTask.id.find(id)) throw new SenderError(`Task ${id} already exists`);
      ctx.db.devTask.insert({ id, title, details: taskDetails(details), area, status: 'open', createdBy: name, assignee: '', dependsOn,
        result: '', createdAt: ctx.timestamp, updatedAt: ctx.timestamp });
      touch(ctx, name);
    }
  );

  // Legacy reducer name retained for existing callers; apply the configured task policy.
  // Preserve task status, ownership, dependencies and results.
  const applyPushPolicy = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
    requireSession(ctx, name);
    for (const task of ctx.db.devTask.iter()) {
      const details = taskDetails(task.details);
      if (details !== task.details) ctx.db.devTask.id.update({ ...task, details, updatedAt: ctx.timestamp });
    }
    touch(ctx, name);
  });

  // Atomic: exactly one session wins a race for the same open task.
  const claimTask = spacetimedb.reducer({ name: t.string(), id: t.string() }, (ctx, { name, id }) => {
    requireSession(ctx, name);
    const task = ctx.db.devTask.id.find(id);
    if (!task) throw new SenderError(`Unknown task ${id}`);
    if (task.status !== 'open') throw new SenderError(`Task ${id} is ${task.status}${task.assignee ? ` (${task.assignee})` : ''}`);
    if (task.dependsOn && (ctx.db.devTask.id.find(task.dependsOn) ?? ctx.db.archivedTask.id.find(task.dependsOn))?.status !== 'done') {
      throw new SenderError(`Task ${id} waits on ${task.dependsOn}`);
    }
    ctx.db.devTask.id.update({ ...task, status: 'claimed', assignee: name, updatedAt: ctx.timestamp });
    touch(ctx, name);
  });

  // The assignee finishes, blocks, or releases (status open) a task; anyone may cancel an open task.
  const updateTask = spacetimedb.reducer(
    { name: t.string(), id: t.string(), status: t.string(), result: t.string() },
    (ctx, { name, id, status, result }) => {
      requireSession(ctx, name);
      const archived = ctx.db.archivedTask.id.find(id);
      const task = ctx.db.devTask.id.find(id) ?? archived;
      if (!task) throw new SenderError(`Unknown task ${id}`);
      if (!TASK_STATUSES.includes(status) || status === 'claimed') throw new SenderError('Status must be open, done, blocked, or cancelled');
      requireText(result, 'Result', 8000, true);
      const cancellingOpen = status === 'cancelled' && task.status === 'open';
      if (!cancellingOpen && task.assignee !== name) throw new SenderError(`Task ${id} is assigned to ${task.assignee || 'nobody'}`);
      const updated = { ...task, status, result, assignee: status === 'open' ? '' : task.assignee, updatedAt: ctx.timestamp };
      if (archived && status === 'open') {
        ctx.db.archivedTask.id.delete(id);
        ctx.db.devTask.insert(updated);
      } else if (archived) ctx.db.archivedTask.id.update(updated);
      else ctx.db.devTask.id.update(updated);
      // Finishing or releasing a task frees the locks taken for it.
      if (status !== 'blocked') {
        for (const lock of [...ctx.db.fileLock.iter()]) {
          if (lock.taskId === id && lock.holder === name) ctx.db.fileLock.path.delete(lock.path);
        }
      }
      touch(ctx, name);
    }
  );

  // Take or extend a lock. Overlapping unexpired locks held by someone else are refused; expired ones are replaced.
  const lock = spacetimedb.reducer(
    { name: t.string(), path: t.string(), taskId: t.string(), reason: t.string(), minutes: t.u32() },
    (ctx, { name, path, taskId, reason, minutes }) => {
      requireSession(ctx, name);
      const normalized = normalizePath(path);
      if (taskId && !(ctx.db.devTask.id.find(taskId) ?? ctx.db.archivedTask.id.find(taskId))) throw new SenderError(`Unknown task ${taskId}`);
      requireText(reason, 'Reason', 512, true);
      if (minutes < 1 || minutes > MAX_LOCK_MINUTES) throw new SenderError(`Minutes must be 1-${MAX_LOCK_MINUTES}`);
      for (const other of [...ctx.db.fileLock.iter()]) {
        if (!overlaps(other.path, normalized)) continue;
        if (expired(ctx, other.expiresAt)) { ctx.db.fileLock.path.delete(other.path); continue; }
        if (other.holder !== name) throw new SenderError(`${normalized} overlaps ${other.path}, locked by ${other.holder}${other.reason ? ` (${other.reason})` : ''}`);
      }
      const row = { path: normalized, holder: name, taskId, reason, acquiredAt: ctx.timestamp,
        expiresAt: new Timestamp(ctx.timestamp.microsSinceUnixEpoch + BigInt(minutes) * MINUTE_MICROS) };
      if (ctx.db.fileLock.path.find(normalized)) ctx.db.fileLock.path.update(row);
      else ctx.db.fileLock.insert(row);
      touch(ctx, name);
    }
  );

  const unlock = spacetimedb.reducer({ name: t.string(), path: t.string() }, (ctx, { name, path }) => {
    requireSession(ctx, name);
    const normalized = normalizePath(path);
    const existing = ctx.db.fileLock.path.find(normalized);
    if (!existing) return;
    if (existing.holder !== name && !expired(ctx, existing.expiresAt)) throw new SenderError(`${normalized} is locked by ${existing.holder}`);
    ctx.db.fileLock.path.delete(normalized);
    touch(ctx, name);
  });

  // Explicit, bounded maintenance on this trusted-local, self-declared-name board.
  // Never reset a database to tidy its dashboard. Snapshot before calling this reducer.
  const cleanupBoard = spacetimedb.reducer(
    { name: t.string(), taskIds: t.array(t.string()), messageIds: t.array(t.u64()) },
    (ctx, { name, taskIds, messageIds }) => {
      requireSession(ctx, name);
      requireOperator(ctx);
      if (taskIds.length > 500 || messageIds.length > 1000) throw new SenderError('Cleanup batch too large');
      for (const id of taskIds) {
        const task = ctx.db.devTask.id.find(id);
        // Recheck status transactionally: a task reopened since the snapshot is retained.
        if (!task || !['done', 'blocked', 'cancelled'].includes(task.status)) continue;
        ctx.db.archivedTask.insert(task);
        ctx.db.devTask.id.delete(id);
      }
      for (const id of messageIds) {
        const message = ctx.db.devMessage.id.find(id);
        if (!message) continue;
        const task = message.taskId ? ctx.db.devTask.id.find(message.taskId) : undefined;
        if (task && ['open', 'claimed'].includes(task.status)) continue;
        ctx.db.devMessage.id.delete(id);
      }
      touch(ctx, name);
    }
  );

  const setTaskPriority = spacetimedb.reducer(
    { name: t.string(), id: t.string(), priority: t.string() },
    (ctx, { name, id, priority }) => {
      requireSession(ctx, name);
      if (!ctx.db.devTask.id.find(id)) throw new SenderError(`Unknown active task ${id}`);
      if (!['low', 'normal', 'high', 'urgent'].includes(priority)) throw new SenderError('Priority must be low, normal, high, or urgent');
      const row = { taskId: id, priority, updatedBy: name, updatedAt: ctx.timestamp };
      if (ctx.db.taskPriority.taskId.find(id)) ctx.db.taskPriority.taskId.update(row);
      else ctx.db.taskPriority.insert(row);
      touch(ctx, name);
    }
  );

  return { setTaskPriority, cleanupBoard, bootstrapBoardOperator, setParticipantLimit, assignSessionIdentity, bindLegacySessions,
    spacetimedb, register, post, createTask, applyPushPolicy, claimTask, updateTask, lock, unlock };
}
