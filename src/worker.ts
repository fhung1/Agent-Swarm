import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DbConnection } from './module_bindings/index.js';
import type { Task } from './module_bindings/types.js';

const name = process.env.AGENT_NAME ?? 'analyst-a';
const runId = process.env.RUN_ID ?? 'demo';
const host = process.env.SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const database = process.env.SPACETIMEDB_DB_NAME ?? 'quant-swarm';
const autoClaim = process.env.AUTO_CLAIM === '1';

if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(name) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) {
  throw new Error('AGENT_NAME or RUN_ID has invalid characters');
}

const tokenFile = process.env.AGENT_TOKEN_FILE ??
  path.join(os.homedir(), '.local', 'share', 'quant-swarm', 'tokens', `${name}.token`);
let connection: DbConnection | undefined;
let retryTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let attempts = 0;
let ready = false;
let stopped = false;
const processing = new Set<string>();

function loadToken(): string | undefined {
  try { return fs.readFileSync(tokenFile, 'utf8').trim() || undefined; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function saveToken(token: string): void {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
}

function scheduleReconnect(reason: unknown): void {
  if (stopped || retryTimer) return;
  ready = false;
  processing.clear();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  console.error('Connection lost:', reason);
  const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts++, 5));
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    connect();
  }, delay);
}

function scanTasks(conn: DbConnection): void {
  if (!ready || !autoClaim) return;
  const me = [...conn.db.agent.iter()].find(row => row.identity.equals(conn.identity!));
  if (!me || !['analyst', 'skeptic', 'coordinator'].includes(me.role)) return;
  for (const task of conn.db.task.iter()) {
    if (task.runId === runId && task.status === 'open' && !processing.has(task.id)) {
      void claimAndComplete(conn, task);
    }
  }
}

async function claimAndComplete(conn: DbConnection, task: Task): Promise<void> {
  processing.add(task.id);
  try {
    await conn.reducers.claimTask({ id: task.id, expectedVersion: task.version });
    console.log(`Claimed ${task.id}`);
    const result = `Demo result from ${name}: reviewed ${task.objective}`;
    await conn.reducers.postMessage({
      id: `${task.id}.${name}.result`, runId, taskId: task.id,
      kind: 'result', body: result, evidenceRef: '',
    });
    await conn.reducers.completeTask({ id: task.id, result });
    console.log(`Completed ${task.id}`);
  } catch (error) {
    console.log(`Could not complete ${task.id}: ${String(error)}`);
  } finally {
    if (connection === conn) processing.delete(task.id);
  }
}

function connect(): void {
  if (stopped) return;
  console.log(`Connecting ${name} to ${host}/${database}`);
  connection = DbConnection.builder()
    .withUri(host)
    .withDatabaseName(database)
    .withToken(loadToken())
    .onConnect((conn, identity, token) => {
      attempts = 0;
      saveToken(token);
      console.log(`Agent ${name} identity: ${identity.toHexString()}`);
      conn.db.task.onInsert((_ctx, row) => { console.log(`Task ${row.id}: ${row.status}`); scanTasks(conn); });
      conn.db.task.onUpdate((_ctx, _old, row) => { console.log(`Task ${row.id}: ${row.status}`); scanTasks(conn); });
      conn.db.message.onInsert((_ctx, row) => console.log(`[${row.runId}] Message ${row.id}: ${row.body}`));
      conn.db.agent.onInsert(() => scanTasks(conn));
      conn.db.agent.onUpdate(() => scanTasks(conn));
      conn.subscriptionBuilder()
        .onApplied(() => {
          ready = true;
          console.log(`General-purpose message board ready (task run: ${runId})`);
          void conn.reducers.heartbeat({}).catch(error => console.log(`Heartbeat awaits grant: ${String(error)}`));
          heartbeatTimer = setInterval(() => {
            void conn.reducers.heartbeat({}).catch(error => console.error('Heartbeat failed:', error));
          }, 15_000);
          scanTasks(conn);
        })
        .onError(ctx => {
          console.error('Subscription failed:', ctx);
          try { conn.disconnect(); } catch { /* Connection may already be closed. */ }
          scheduleReconnect('Subscription ended');
        })
        .subscribe([
          'SELECT * FROM agent',
          'SELECT * FROM run',
          'SELECT * FROM task',
          'SELECT * FROM message',
        ]);
    })
    .onConnectError((_ctx, error) => scheduleReconnect(error))
    .onDisconnect((_ctx, error) => scheduleReconnect(error))
    .build();
}

process.on('SIGINT', () => {
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  connection?.disconnect();
  process.exit(0);
});

connect();
