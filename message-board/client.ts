import { DbConnection } from './bindings/index.js';
import type { DevTask, Session, DevMessage, FileLock } from './bindings/types.js';

export type BoardTask = DevTask;
export type Participant = Session;
export type BoardMessage = DevMessage;
export type Reservation = FileLock;
export type BoardSnapshot = { tasks: BoardTask[]; participants: Participant[]; messages: BoardMessage[]; reservations: Reservation[] };
export const emptySnapshot = (): BoardSnapshot => ({ tasks: [], participants: [], messages: [], reservations: [] });
export type BoardClientOptions = {
  uri: string; database: string; token?: string;
  onToken?: (token: string) => void;
  onChange?: () => void;
};

/** Shared Node/browser client. It contains no application names, DOM, or storage policy. */
export class MessageBoardClient {
  private connection?: DbConnection;
  private generation = 0;
  private retry = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private token?: string;
  ready = false;
  state = 'Disconnected';
  identity = '';
  constructor(private options: BoardClientOptions) { this.token = options.token; }
  private changed = (): void => { this.options.onChange?.(); };
  start(): void {
    this.stop();
    const current = ++this.generation;
    this.state = 'Connecting…'; this.changed();
    const failed = (reason: unknown) => {
      if (current !== this.generation) return;
      ++this.generation;
      this.ready = false;
      const old = this.connection; this.connection = undefined; old?.disconnect();
      this.state = `Connection unavailable: ${String(reason)}. Retrying…`; this.changed();
      this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, Math.min(30_000, 1000 * 2 ** Math.min(this.retry++, 5)));
    };
    this.connection = DbConnection.builder().withUri(this.options.uri).withDatabaseName(this.options.database).withToken(this.token)
      .onConnect((conn, identity, token) => {
        if (current !== this.generation) { conn.disconnect(); return; }
        this.connection = conn; this.identity = identity.toHexString(); this.token = token;
        this.options.onToken?.(token);
        for (const table of [conn.db.session, conn.db.devTask, conn.db.devMessage, conn.db.fileLock]) {
          table.onInsert(this.changed); table.onUpdate(this.changed); table.onDelete(this.changed);
        }
        conn.subscriptionBuilder()
          .onApplied(() => { if (current === this.generation) { this.ready = true; this.retry = 0; this.state = 'Live'; this.changed(); } })
          .onError(ctx => failed(ctx.event ?? 'Subscription failed'))
          .subscribe(['SELECT * FROM session', 'SELECT * FROM dev_task', 'SELECT * FROM dev_message', 'SELECT * FROM file_lock']);
      }).onConnectError((_ctx, error) => failed(error)).onDisconnect((_ctx, error) => failed(error)).build();
  }
  stop(): void {
    ++this.generation; clearTimeout(this.timer); this.timer = undefined;
    this.ready = false; this.connection?.disconnect(); this.connection = undefined;
    this.state = 'Disconnected';
  }
  snapshot(): BoardSnapshot {
    if (!this.ready || !this.connection) return emptySnapshot();
    const db = this.connection.db;
    return { tasks: [...db.devTask.iter()], participants: [...db.session.iter()], messages: [...db.devMessage.iter()], reservations: [...db.fileLock.iter()] };
  }
  private get reducers() {
    if (!this.ready || !this.connection) throw new Error('Board is disconnected; wait for the subscription snapshot');
    return this.connection.reducers;
  }
  register(name: string, type: string, focus = '') { return this.reducers.register({ name, tool: type, focus }); }
  post(sender: string, body: string, recipient = '', taskId = '') { return this.reducers.post({ sender, body, recipient, taskId }); }
  createTask(name: string, task: { id: string; title: string; details?: string; area?: string; dependsOn?: string }) {
    return this.reducers.createTask({ name, details: '', area: '', dependsOn: '', ...task });
  }
  claimTask(name: string, id: string) { return this.reducers.claimTask({ name, id }); }
  updateTask(name: string, id: string, status: 'open' | 'done' | 'blocked' | 'cancelled', result = '') {
    return this.reducers.updateTask({ name, id, status, result });
  }
  reserve(name: string, path: string, taskId = '', reason = '', minutes = 120) {
    return this.reducers.lock({ name, path, taskId, reason, minutes });
  }
  releaseReservation(name: string, path: string) { return this.reducers.unlock({ name, path }); }
}
