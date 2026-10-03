import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { DbConnection } from '../module_bindings/index.js';

export type SessionOptions = { host: string; database: string; tokenFile: string };

/** A fresh subscription snapshot is the boundary for every connection generation. */
export class ChatSession {
  connection?: DbConnection;
  ready = false;
  generation = 0;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private attempts = 0;
  private listeners = new Set<() => void>();

  constructor(readonly options: SessionOptions) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void { for (const listener of this.listeners) listener(); }

  start(): void {
    if (this.stopped || this.connection) return;
    let token: string | undefined;
    try { token = readFileSync(this.options.tokenFile, 'utf8').trim() || undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const generation = ++this.generation;
    const current = () => !this.stopped && this.generation === generation;
    const lost = () => {
      if (!current()) return;
      ++this.generation;
      this.ready = false;
      const old = this.connection;
      this.connection = undefined;
      try { old?.disconnect(); } catch { /* Already disconnected. */ }
      this.changed();
      const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempts++, 6));
      this.retry = setTimeout(() => { this.retry = undefined; this.start(); }, delay);
    };
    this.connection = DbConnection.builder()
      .withUri(this.options.host).withDatabaseName(this.options.database).withToken(token)
      .onConnect((conn, _identity, savedToken) => {
        if (!current()) { conn.disconnect(); return; }
        mkdirSync(dirname(this.options.tokenFile), { recursive: true, mode: 0o700 });
        writeFileSync(this.options.tokenFile, savedToken, { mode: 0o600 });
        chmodSync(this.options.tokenFile, 0o600);
        const notify = () => { if (current() && this.ready) this.changed(); };
        conn.db.myMessage.onInsert(notify); conn.db.myMessage.onUpdate(notify); conn.db.myMessage.onDelete(notify);
        conn.db.myTask.onInsert(notify); conn.db.myTask.onUpdate(notify); conn.db.myTask.onDelete(notify);
        conn.db.myRun.onInsert(notify); conn.db.myRun.onUpdate(notify); conn.db.myRun.onDelete(notify);
        conn.db.myAgentDirectory.onInsert(notify); conn.db.myAgentDirectory.onUpdate(notify); conn.db.myAgentDirectory.onDelete(notify);
        conn.subscriptionBuilder().onApplied(() => {
          if (!current()) return;
          this.attempts = 0; this.ready = true; this.changed();
        }).onError(lost).subscribe([
          'SELECT * FROM my_agent_directory',
          'SELECT * FROM my_run', 'SELECT * FROM my_task', 'SELECT * FROM my_message',
        ]);
      }).onDisconnect(lost).onConnectError(lost).build();
  }

  stop(): void {
    this.stopped = true; this.ready = false; ++this.generation;
    if (this.retry) clearTimeout(this.retry);
    try { this.connection?.disconnect(); } catch { /* Already closed. */ }
    this.connection = undefined; this.changed();
  }
}
