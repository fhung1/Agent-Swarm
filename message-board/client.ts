import { PRIORITIES, comparePriority, type TaskPriority } from './priority.js';
import { Identity } from 'spacetimedb';
import { DbConnection } from './bindings/index.js';
import type { DevTask, Session, DevMessage, FileLock } from './bindings/types.js';

export type BoardTask = DevTask & { priority: TaskPriority };
export type Participant = Session;
export type BoardMessage = DevMessage;
export type Reservation = FileLock;
export type BoardSnapshot = { tasks: BoardTask[]; participants: Participant[]; messages: BoardMessage[]; reservations: Reservation[] };
export const emptySnapshot = (): BoardSnapshot => ({ tasks: [], participants: [], messages: [], reservations: [] });
export type BoardClientOptions = {
  uri: string; database: string; token?: string;
  onToken?: (token: string) => void;
  onChange?: () => void;
  /** Restrict browser snapshots to recent history while keeping active tasks visible. */
  historyWindowMs?: number;
  /** Reapply the moving history window without reconnecting the database connection. */
  historyRefreshMs?: number;
};

/** Shared Node/browser client. It contains no application names, DOM, or storage policy. */
export class MessageBoardClient {
  private connection?: DbConnection;
  private subscription?: { isActive(): boolean; unsubscribe(): void };
  private generation = 0;
  private retry = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private historyTimer?: ReturnType<typeof setTimeout>;
  private token?: string;
  ready = false;
  state = 'Disconnected';
  identity = '';
  constructor(private options: BoardClientOptions) {
    this.token = options.token;
    if (options.historyWindowMs !== undefined && (!Number.isSafeInteger(options.historyWindowMs) || options.historyWindowMs <= 0)) {
      throw new Error('historyWindowMs must be a positive safe integer');
    }
    if (options.historyRefreshMs !== undefined && (!Number.isSafeInteger(options.historyRefreshMs) || options.historyRefreshMs <= 0)) {
      throw new Error('historyRefreshMs must be a positive safe integer');
    }
  }
  private changed = (): void => { this.options.onChange?.(); };
  private historyQueries(now: number): string[] {
    const windowMs = this.options.historyWindowMs;
    if (windowMs === undefined) return [
      'SELECT * FROM session', 'SELECT * FROM dev_task', 'SELECT * FROM dev_message', 'SELECT * FROM file_lock', 'SELECT * FROM task_priority',
    ];
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) throw new Error('historyWindowMs must be a positive safe integer');
    const cutoff = new Date(now - windowMs).toISOString();
    const current = new Date(now).toISOString();
    const taskScope = `(dev_task.updated_at >= '${cutoff}' OR dev_task.status = 'open' OR dev_task.status = 'claimed' OR dev_task.status = 'blocked')`;
    return [
      `SELECT * FROM session WHERE last_seen >= '${cutoff}'`,
      `SELECT * FROM dev_task WHERE updated_at >= '${cutoff}' OR status = 'open' OR status = 'claimed' OR status = 'blocked'`,
      `SELECT * FROM dev_message WHERE created_at >= '${cutoff}'`,
      `SELECT * FROM file_lock WHERE expires_at > '${current}'`,
      `SELECT task_priority.* FROM task_priority JOIN dev_task ON task_priority.task_id = dev_task.id WHERE ${taskScope} OR task_priority.updated_at >= '${cutoff}'`,
      `SELECT dev_task.* FROM dev_task JOIN task_priority ON task_priority.task_id = dev_task.id WHERE task_priority.updated_at >= '${cutoff}'`,
    ];
  }
  private subscribe(current: number, connection: DbConnection): void {
    const previous = this.subscription;
    let next: { isActive(): boolean; unsubscribe(): void } | undefined;
    next = connection.subscriptionBuilder()
      .onApplied(() => {
        if (current !== this.generation || this.connection !== connection) {
          if (next?.isActive()) next.unsubscribe();
          return;
        }
        this.subscription = next;
        this.ready = true;
        this.retry = 0;
        this.state = 'Live';
        if (previous && previous !== next && previous.isActive()) previous.unsubscribe();
        this.changed();
        if (this.options.historyWindowMs !== undefined) {
          clearTimeout(this.historyTimer);
          const refreshMs = this.options.historyRefreshMs ?? 60 * 60_000;
          this.historyTimer = setTimeout(() => {
            this.historyTimer = undefined;
            if (current === this.generation && this.connection === connection) this.subscribe(current, connection);
          }, refreshMs);
        }
      })
      .onError(ctx => {
        if (current === this.generation && this.connection === connection) this.failed(current, ctx.event ?? 'Subscription failed');
      })
      .subscribe(this.historyQueries(Date.now()));
    this.subscription = next;
  }
  private failed(current: number, reason: unknown): void {
    if (current !== this.generation) return;
    ++this.generation;
    this.ready = false;
    clearTimeout(this.historyTimer);
    this.historyTimer = undefined;
    this.subscription = undefined;
    const old = this.connection; this.connection = undefined; old?.disconnect();
    this.state = `Connection unavailable: ${String(reason)}. Retrying…`; this.changed();
    this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, Math.min(30_000, 1000 * 2 ** Math.min(this.retry++, 5)));
  }
  start(): void {
    this.stop();
    const current = ++this.generation;
    this.state = 'Connecting…'; this.changed();
    this.connection = DbConnection.builder().withUri(this.options.uri).withDatabaseName(this.options.database).withToken(this.token)
      .onConnect((conn, identity, token) => {
        if (current !== this.generation) { conn.disconnect(); return; }
        this.connection = conn; this.identity = identity.toHexString(); this.token = token;
        this.options.onToken?.(token);
        for (const table of [conn.db.session, conn.db.devTask, conn.db.devMessage, conn.db.fileLock, conn.db.taskPriority]) {
          table.onInsert(this.changed); table.onUpdate(this.changed); table.onDelete(this.changed);
        }
        this.connection = conn;
        this.subscribe(current, conn);
      }).onConnectError((_ctx, error) => this.failed(current, error)).onDisconnect((_ctx, error) => this.failed(current, error)).build();
  }
  stop(): void {
    ++this.generation; clearTimeout(this.timer); this.timer = undefined;
    clearTimeout(this.historyTimer); this.historyTimer = undefined; this.subscription = undefined;
    this.ready = false; this.connection?.disconnect(); this.connection = undefined;
    this.state = 'Disconnected';
  }
  snapshot(): BoardSnapshot {
    if (!this.ready || !this.connection) return emptySnapshot();
    const db = this.connection.db;
    const tasks = [...db.devTask.iter()].map(task => ({ ...task, priority: (db.taskPriority.taskId.find(task.id)?.priority ?? 'normal') as TaskPriority }));
    tasks.sort(comparePriority);
    return { tasks, participants: [...db.session.iter()], messages: [...db.devMessage.iter()], reservations: [...db.fileLock.iter()] };
  }
  private get reducers() {
    if (!this.ready || !this.connection) throw new Error('Board is disconnected; wait for the subscription snapshot');
    return this.connection.reducers;
  }
  register(name: string, type: string, focus = '') { return this.reducers.register({ name, tool: type, focus }); }
  bootstrapOperator() { return this.reducers.bootstrapBoardOperator({}); }
  assignSessionIdentity(name: string, identity: string) { return this.reducers.assignSessionIdentity({ name, identity: new Identity(identity) }); }
  bindLegacySessions() { return this.reducers.bindLegacySessions({}); }
  cleanup(name: string, taskIds: string[] = [], messageIds: bigint[] = []) {
    return this.reducers.cleanupBoard({ name, taskIds, messageIds });
  }
  post(sender: string, body: string, recipient = '', taskId = '') { return this.reducers.post({ sender, body, recipient, taskId }); }
  async createTask(name: string, task: { id: string; title: string; details?: string; area?: string; dependsOn?: string; priority?: TaskPriority }) {
    const { priority, ...fields } = task;
    if (priority !== undefined && !PRIORITIES.includes(priority)) throw new Error('Invalid task priority');
    await this.reducers.createTask({ name, details: '', area: '', dependsOn: '', ...fields });
    if (priority !== undefined) await this.setTaskPriority(name, task.id, priority);
  }
  setTaskPriority(name: string, id: string, priority: TaskPriority) { return this.reducers.setTaskPriority({ name, id, priority }); }
  claimTask(name: string, id: string) { return this.reducers.claimTask({ name, id }); }
  updateTask(name: string, id: string, status: 'open' | 'done' | 'blocked' | 'cancelled', result = '') {
    return this.reducers.updateTask({ name, id, status, result });
  }
  reserve(name: string, path: string, taskId = '', reason = '', minutes = 120) {
    return this.reducers.lock({ name, path, taskId, reason, minutes });
  }
  releaseReservation(name: string, path: string) { return this.reducers.unlock({ name, path }); }
}
