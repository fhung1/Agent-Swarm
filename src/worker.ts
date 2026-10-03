import { DbConnection } from './module_bindings/index.js';
import type { Task } from './module_bindings/types.js';
import { defaultTokenFile, loadToken, saveToken } from './tokens.js';

const name = process.env.AGENT_NAME ?? 'analyst-a';
const runId = process.env.RUN_ID ?? 'demo';
const host = process.env.SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const database = process.env.SPACETIMEDB_DB_NAME ?? 'quant-swarm';
const autoClaim = process.env.AUTO_CLAIM === '1';
// Simulates a slow model call so lease renewal and restart recovery can be exercised.
const workDelayMs = Number(process.env.WORK_DELAY_MS ?? '0');
const RENEW_MS = 20_000;
const STALE_SOURCE_DAYS = 400;

if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(name) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) {
  throw new Error('AGENT_NAME or RUN_ID has invalid characters');
}
if (!Number.isInteger(workDelayMs) || workDelayMs < 0 || workDelayMs > 600_000) {
  throw new Error('WORK_DELAY_MS must be an integer from 0 to 600000');
}

const tokenFile = process.env.AGENT_TOKEN_FILE ?? defaultTokenFile(name);
let connection: DbConnection | undefined;
let retryTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let attempts = 0;
let ready = false;
let stopped = false;
// Keys of in-flight work: task IDs for claimed tasks, `coord:` keys for coordinator actions.
const processing = new Set<string>();

type Outcome = { ok: boolean; text: string };

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

// The granted role in the agent table is authoritative; the process name is only a label.
function myRole(conn: DbConnection): string | undefined {
  return conn.db.agent.identity.find(conn.identity!)?.role;
}

function runTasks(conn: DbConnection): Task[] {
  return [...conn.db.task.iter()].filter(task => task.runId === runId);
}

function handlerRole(task: Task): string | undefined {
  if (task.kind === 'thesis') return 'analyst';
  if (task.kind === 'review') return 'skeptic';
  return undefined;
}

function scan(conn: DbConnection): void {
  if (!ready || !autoClaim) return;
  const role = myRole(conn);
  if (!role || !['analyst', 'skeptic', 'coordinator'].includes(role)) return;
  if (role === 'coordinator') coordinate(conn);
  for (const task of runTasks(conn)) {
    if (processing.has(task.id)) continue;
    // A claimed task assigned to this identity was interrupted by a restart or reconnect: resume it.
    if (task.status === 'claimed' && task.assignee?.equals(conn.identity!)) {
      void runTask(conn, task, false);
    } else if (task.status === 'open' && handlerRole(task) === role && (!task.role || task.role === role) &&
               (!task.dependsOn || conn.db.task.id.find(task.dependsOn)?.status === 'completed')) {
      void runTask(conn, task, true);
    }
  }
}

async function runTask(conn: DbConnection, task: Task, claim: boolean): Promise<void> {
  processing.add(task.id);
  let renewTimer: NodeJS.Timeout | undefined;
  try {
    if (claim) {
      await conn.reducers.claimTask({ id: task.id, expectedVersion: task.version });
      console.log(`Claimed ${task.id}`);
    } else {
      console.log(`Resuming ${task.id}`);
    }
    renewTimer = setInterval(() => {
      void conn.reducers.renewTaskLease({ id: task.id })
        .then(() => console.log(`Renewed lease on ${task.id}`))
        .catch(error => console.log(`Lease renewal failed for ${task.id}: ${String(error)}`));
    }, RENEW_MS);
    if (workDelayMs) await new Promise(resolve => setTimeout(resolve, workDelayMs));
    const outcome = task.kind === 'thesis' ? await writeThesis(conn, task) : await reviewThesis(conn, task);
    if (outcome.ok) await conn.reducers.completeTask({ id: task.id, result: outcome.text });
    else await conn.reducers.failTask({ id: task.id, reason: outcome.text });
    console.log(`${outcome.ok ? 'Completed' : 'Failed'} ${task.id}: ${outcome.text}`);
  } catch (error) {
    console.log(`Could not finish ${task.id}: ${String(error)}`);
    // Fail a task this worker still holds so a permanent error is recorded once instead of retried on every update.
    const current = conn.db.task.id.find(task.id);
    if (current?.status === 'claimed' && current.assignee?.equals(conn.identity!)) {
      await conn.reducers.failTask({ id: task.id, reason: clip(`Worker error: ${String(error)}`) })
        .catch(failError => console.log(`Could not record failure for ${task.id}: ${String(failError)}`));
    }
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    if (connection === conn) processing.delete(task.id);
  }
}

function clip(text: string, max = 4000): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// Placeholder analyst: summarizes stored evidence deterministically. A model call replaces this later.
async function writeThesis(conn: DbConnection, task: Task): Promise<Outcome> {
  const sources = [...conn.db.source.iter()]
    .filter(source => source.runId === runId && source.symbol === task.symbol)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (sources.length === 0) return { ok: false, text: `No stored sources for ${task.symbol} in run ${runId}` };
  const sourceIds = new Set(sources.map(source => source.id));
  const facts = [...conn.db.fact.iter()]
    .filter(fact => sourceIds.has(fact.sourceId))
    .sort((a, b) => a.id.localeCompare(b.id));
  const thesisId = `thesis.${task.id}`;
  if (!conn.db.thesis.id.find(thesisId)) {
    const factText = facts.map(fact => `${fact.metric}=${fact.value} ${fact.unit} (${fact.period})`).join('; ') || 'no extracted facts';
    await conn.reducers.publishThesis({
      id: thesisId, runId, taskId: task.id, symbol: task.symbol,
      bullCase: clip(`Placeholder summary, no model analysis: ${sources.length} source(s); ${factText}.`),
      bearCase: 'No valuation, competitive, or counter-evidence analysis has been run.',
      assumptions: 'Cited sources are accurate as of their as-of dates.',
      invalidation: 'A cited source is superseded, amended, or contradicted by newer evidence.',
      evidenceRefs: [...sourceIds, ...facts.map(fact => fact.id)].slice(0, 50).join(','),
    });
  }
  await conn.reducers.postMessage({
    id: `${thesisId}.claim`, runId, taskId: task.id, symbol: task.symbol, recipientRole: 'coordinator',
    kind: 'claim', body: `Thesis ${thesisId} published for ${task.symbol}`, evidenceRef: thesisId,
  });
  return { ok: true, text: thesisId };
}

// Placeholder skeptic: rule-based evidence-quality checks against the thesis's citations.
async function reviewThesis(conn: DbConnection, task: Task): Promise<Outcome> {
  const thesisId = conn.db.task.id.find(task.dependsOn)?.result ?? '';
  const thesis = conn.db.thesis.id.find(thesisId);
  if (!thesis) return { ok: false, text: `Thesis ${thesisId || '(none)'} for dependency ${task.dependsOn} not found` };
  if (thesis.symbol !== task.symbol) return { ok: false, text: `Thesis ${thesisId} is for ${thesis.symbol}, not ${task.symbol}` };
  const concerns: string[] = [];
  const refs = thesis.evidenceRefs.split(',').filter(Boolean);
  const nowMicros = BigInt(Date.now()) * 1000n;
  let sourceCount = 0;
  for (const ref of refs) {
    const source = conn.db.source.id.find(ref);
    const fact = conn.db.fact.id.find(ref);
    if (source) {
      sourceCount++;
      if (source.kind === 'fixture') concerns.push(`${ref} is fixture data`);
      const ageDays = Number((nowMicros - source.asOf.microsSinceUnixEpoch) / 86_400_000_000n);
      if (ageDays > STALE_SOURCE_DAYS) concerns.push(`${ref} is ${ageDays} days old`);
    } else if (fact && fact.quality !== 'ok') {
      concerns.push(`${ref} has quality ${fact.quality}`);
    }
  }
  if (sourceCount < 2) concerns.push(`only ${sourceCount} independent source(s)`);
  const body = clip(concerns.length ? `concerns: ${concerns.join('; ')}` : 'pass: no evidence-quality issues found by rule checks');
  await conn.reducers.postMessage({
    id: `${task.id}.challenge`, runId, taskId: task.id, symbol: task.symbol, recipientRole: 'coordinator',
    kind: 'challenge', body, evidenceRef: thesisId,
  });
  return { ok: true, text: body };
}

// Placeholder coordinator: queues a skeptic review for each thesis, then records a decision from the review.
function coordinate(conn: DbConnection): void {
  for (const task of runTasks(conn)) {
    if (task.status !== 'completed') continue;
    if (task.kind === 'thesis') {
      const reviewId = `review.${task.id}`;
      if (conn.db.task.id.find(reviewId)) continue;
      void once(`coord:${reviewId}`, async () => {
        await conn.reducers.createTask({
          id: reviewId, runId, symbol: task.symbol, kind: 'review',
          objective: `Challenge thesis ${task.result}`, role: 'skeptic', dependsOn: task.id,
        });
        console.log(`Queued ${reviewId}`);
      });
    } else if (task.kind === 'review') {
      const thesisId = conn.db.task.id.find(task.dependsOn)?.result ?? '';
      if (!conn.db.thesis.id.find(thesisId)) continue;
      const decisionId = `decision.${thesisId}`;
      const messageId = `${decisionId}.msg`;
      if (conn.db.message.id.find(messageId)) continue;
      void once(`coord:${decisionId}`, async () => {
        const passed = task.result.startsWith('pass');
        // Phase 1 has no valuation model, so the coordinator never decides to trade.
        const outcome = passed ? 'abstain' : 'revise';
        const rationale = passed
          ? 'Skeptic found no evidence-quality issues, but no valuation model exists yet; abstaining.'
          : `Skeptic review raised ${task.result}`;
        if (![...conn.db.decision.iter()].some(row => row.thesisId === thesisId)) {
          await conn.reducers.recordDecision({ id: decisionId, thesisId, outcome, rationale: clip(rationale) });
        }
        await conn.reducers.postMessage({
          id: messageId, runId, taskId: task.id, symbol: task.symbol, recipientRole: '',
          kind: 'decision', body: clip(`${outcome} on ${thesisId}: ${rationale}`), evidenceRef: thesisId,
        });
        console.log(`Decided ${thesisId}: ${outcome}`);
      });
    }
  }
}

async function once(key: string, action: () => Promise<void>): Promise<void> {
  if (processing.has(key)) return;
  const conn = connection;
  processing.add(key);
  try { await action(); }
  catch (error) { console.log(`Coordinator action ${key} failed: ${String(error)}`); }
  finally { if (connection === conn) processing.delete(key); }
}

function connect(): void {
  if (stopped) return;
  console.log(`Connecting ${name} to ${host}/${database}`);
  connection = DbConnection.builder()
    .withUri(host)
    .withDatabaseName(database)
    .withToken(loadToken(tokenFile))
    .onConnect((conn, identity, token) => {
      attempts = 0;
      saveToken(tokenFile, token);
      console.log(`Agent ${name} identity: ${identity.toHexString()}`);
      const rescan = () => scan(conn);
      conn.db.task.onInsert((_ctx, row) => { console.log(`Task ${row.id}: ${row.status}`); rescan(); });
      conn.db.task.onUpdate((_ctx, _old, row) => { console.log(`Task ${row.id}: ${row.status}`); rescan(); });
      conn.db.message.onInsert((_ctx, row) => {
        console.log(`Message ${row.id} [${row.kind}${row.recipientRole ? ` → ${row.recipientRole}` : ''}]: ${row.body}`);
        rescan();
      });
      conn.db.agent.onInsert(rescan);
      conn.db.agent.onUpdate(rescan);
      conn.db.thesis.onInsert(rescan);
      conn.subscriptionBuilder()
        .onApplied(() => {
          ready = true;
          console.log(`Subscription ready for run ${runId} (role: ${myRole(conn) ?? 'not granted'})`);
          void conn.reducers.heartbeat({}).catch(error => console.log(`Heartbeat awaits grant: ${String(error)}`));
          heartbeatTimer = setInterval(() => {
            void conn.reducers.heartbeat({}).catch(error => console.error('Heartbeat failed:', error));
          }, 15_000);
          scan(conn);
        })
        .onError(ctx => {
          console.error('Subscription failed:', ctx);
          try { conn.disconnect(); } catch { /* Connection may already be closed. */ }
          scheduleReconnect('Subscription ended');
        })
        .subscribe([
          'SELECT * FROM agent',
          'SELECT * FROM run',
          `SELECT * FROM task WHERE run_id = '${runId}'`,
          `SELECT * FROM message WHERE run_id = '${runId}'`,
          `SELECT * FROM source WHERE run_id = '${runId}'`,
          `SELECT * FROM thesis WHERE run_id = '${runId}'`,
          'SELECT * FROM fact',
          'SELECT * FROM decision',
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
