import { DbConnection } from './module_bindings/index.js';
import type { Task } from './module_bindings/types.js';
import { recordId } from './ids.js';
import { isPermanent } from './work-errors.js';
import { defaultTokenFile, loadToken, saveToken } from './tokens.js';
import { createAsker } from './agents/llm.js';
import { evidenceFor, modelDecide, modelReviewThesis, modelSpecialistReport, modelWriteThesis } from './agents/model-handlers.js';
import { toSpecialistMessageArgs } from './agents/roles.js';
import { parsePositions } from './agents/risk.js';
import { planPositionReviews } from './position-reviews.js';

const name = process.env.AGENT_NAME ?? 'analyst-a';
const runId = process.env.RUN_ID ?? 'demo';
const host = process.env.SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const database = process.env.SPACETIMEDB_DB_NAME ?? 'quant-swarm';
const autoClaim = process.env.AUTO_CLAIM === '1';
// Simulates a slow model call so lease renewal and restart recovery can be exercised.
const workDelayMs = Number(process.env.WORK_DELAY_MS ?? '0');
const RENEW_MS = 20_000;
const STALE_SOURCE_DAYS = 400;
// The granted role decides what a worker does; the brain decides how: `rules` placeholders, or Claude or Codex model calls.
const brain = process.env.AGENT_BRAIN ?? 'rules';
if (brain !== 'rules' && brain !== 'claude' && brain !== 'codex') throw new Error('AGENT_BRAIN must be rules, claude, or codex');
const ask = brain === 'rules' ? undefined : createAsker(brain);
const teamValuation = process.env.TEAM_VALUATION === '1';
const teamPortfolio = process.env.TEAM_PORTFOLIO === '1';
const positionReviewDays = Number(process.env.POSITION_REVIEW_DAYS ?? '0');
const positionReviewPriceMovePct = Number(process.env.POSITION_REVIEW_PRICE_MOVE_PCT ?? '0');
if (positionReviewDays && (!Number.isInteger(positionReviewDays) || positionReviewDays < 1 || positionReviewDays > 365 ||
    !Number.isFinite(positionReviewPriceMovePct) || positionReviewPriceMovePct <= 0 || positionReviewPriceMovePct > 100)) {
  throw new Error('Invalid position review configuration');
}

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
let connectionGeneration = 0;
// Keys of in-flight work: task IDs for claimed tasks, `coord:` keys for coordinator actions.
const processing = new Set<string>();
const controllers = new Map<string, AbortController>();
const retryAt = new Map<string, number>();
const failures = new Map<string, number>();
const MAX_CONCURRENT_TASKS = 2;

type Outcome = { ok: boolean; text: string };

function scheduleReconnect(reason: unknown, generation: number): void {
  if (stopped || retryTimer || generation !== connectionGeneration) return;
  ready = false;
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
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
  return conn.db.myAgent.identity.find(conn.identity!)?.role;
}

function runTasks(conn: DbConnection): Task[] {
  return [...conn.db.myTask.iter()].filter(task => task.runId === runId);
}

function handlerRole(task: Task): string | undefined {
  if (task.kind === 'thesis' || task.kind === 'position_review') return 'analyst';
  if (task.kind === 'valuation' || task.kind === 'portfolio') return task.kind;
  if (task.kind === 'review') return 'skeptic';
  return undefined;
}

function scan(conn: DbConnection): void {
  if (connection !== conn || !ready || !autoClaim) return;
  const role = myRole(conn);
  if (conn.db.myRun.id.find(runId)?.status !== 'active' || !role) {
    for (const controller of controllers.values()) controller.abort();
    return;
  }
  if (!role || !['analyst', 'valuation', 'portfolio', 'skeptic', 'coordinator'].includes(role)) return;
  if (role === 'coordinator') coordinate(conn);
  for (const task of runTasks(conn)) {
    if (processing.has(task.id) || controllers.size >= MAX_CONCURRENT_TASKS || (retryAt.get(task.id) ?? 0) > Date.now()) continue;
    // A claimed task assigned to this identity was interrupted by a restart or reconnect: resume it.
    if (task.status === 'claimed' && task.assignee?.equals(conn.identity!)) {
      void runTask(conn, task, false);
    } else if (task.status === 'open' && handlerRole(task) === role && (!task.role || task.role === role) &&
               (!task.dependsOn || conn.db.myTask.id.find(task.dependsOn)?.status === 'completed')) {
      void runTask(conn, task, true);
    }
  }
}

async function runTask(conn: DbConnection, task: Task, claim: boolean): Promise<void> {
  processing.add(task.id);
  const controller = new AbortController();
  controllers.set(task.id, controller);
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
        .catch(error => {
          controller.abort();
          console.log(`Lease renewal failed for ${task.id}: ${String(error)}`);
        });
    }, RENEW_MS);
    if (workDelayMs) await new Promise(resolve => setTimeout(resolve, workDelayMs));
    controller.signal.throwIfAborted();
    if (conn.db.myRun.id.find(runId)?.status !== 'active') return;
    const outcome = ask
      ? ['thesis', 'position_review'].includes(task.kind) ? await modelWriteThesis(ask, conn, task, runId, controller.signal)
        : task.kind === 'review' ? await modelReviewThesis(ask, conn, task, runId, controller.signal)
        : await modelSpecialistReport(ask, conn, task, runId, controller.signal)
      : ['thesis', 'position_review'].includes(task.kind) ? await writeThesis(conn, task)
        : task.kind === 'review' ? await reviewThesis(conn, task)
        : await rulesSpecialistReport(conn, task);
    controller.signal.throwIfAborted();
    if (outcome.ok) await conn.reducers.completeTask({ id: task.id, result: outcome.text });
    else await conn.reducers.failTask({ id: task.id, reason: outcome.text });
    retryAt.delete(task.id); failures.delete(task.id);
    console.log(`${outcome.ok ? 'Completed' : 'Failed'} ${task.id}: ${outcome.text}`);
  } catch (error) {
    console.log(`Could not finish ${task.id}: ${String(error)}`);
    // Fail a task this worker still holds so a permanent error is recorded once instead of retried on every update.
    const current = conn.db.myTask.id.find(task.id);
    const count = (failures.get(task.id) ?? 0) + 1;
    if (!controller.signal.aborted) failures.set(task.id, count);
    const terminal = isPermanent(error) || count >= 3;
    if (terminal && !controller.signal.aborted && conn.db.myRun.id.find(runId)?.status === 'active' && current?.status === 'claimed' && current.assignee?.equals(conn.identity!)) {
      await conn.reducers.failTask({ id: task.id, reason: clip(`Worker error: ${String(error)}`) })
        .catch(failError => console.log(`Could not record failure for ${task.id}: ${String(failError)}`));
    } else {
      retryAt.set(task.id, Date.now() + Math.min(30_000, 1000 * 2 ** count));
    }
  } finally {
    if (controllers.get(task.id) === controller) controllers.delete(task.id);
    if (renewTimer) clearInterval(renewTimer);
    if (connection === conn) processing.delete(task.id);
  }
}

async function rulesSpecialistReport(conn: DbConnection, task: Task): Promise<Outcome> {
  const kind = task.kind as 'valuation' | 'portfolio';
  const thesisId = conn.db.myTask.id.find(task.dependsOn)?.result ?? '';
  if (!conn.db.myThesis.id.find(thesisId)) return { ok: false, text: 'Specialist thesis missing' };
  const messageId = recordId('', task.id, '.report');
  if (!conn.db.myMessage.id.find(messageId)) {
    const output = kind === 'valuation'
      ? { status: 'insufficient' as const, bear_value: null, base_value: null, bull_value: null,
          assumptions: 'Rule worker does not estimate intrinsic value', risks: 'Model valuation unavailable', evidence_ids: [] }
      : { status: 'insufficient' as const, exposure: 'Rule worker does not assess portfolio exposure',
          liquidity: 'Unavailable', concentration: 'Unavailable', recommendation: 'No trade recommendation', evidence_ids: [] };
    await conn.reducers.postMessage(toSpecialistMessageArgs(kind, output,
      { messageId, runId, taskId: task.id, symbol: task.symbol, thesisId }, new Set()));
  }
  return { ok: true, text: messageId };
}

function clip(text: string, max = 4000): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// Placeholder analyst: summarizes stored evidence deterministically. A model call replaces this later.
async function writeThesis(conn: DbConnection, task: Task): Promise<Outcome> {
  const thesisId = recordId('thesis.', task.id);
  if (!conn.db.myThesis.id.find(thesisId)) {
    const { sources, facts, refs, omitted } = evidenceFor(conn,runId,task.symbol);
    if (sources.length === 0) return { ok: false, text: `No stored sources for ${task.symbol} in run ${runId}` };
    const factText = facts.map(fact => `${fact.metric}=${fact.value} ${fact.unit} (${fact.period})`).join('; ') || 'no extracted facts';
    await conn.reducers.publishThesis({
      id: thesisId, runId, taskId: task.id, symbol: task.symbol,
      bullCase: clip(`Placeholder summary, no model analysis: ${sources.length} source(s); ${factText}.`),
      bearCase: clip('No valuation, competitive, or counter-evidence analysis has been run.' +
        ` Omitted evidence IDs: ${[...omitted.sources,...omitted.facts,...omitted.observations].join(', ') || '(none)'}`),
      assumptions: 'Cited sources are accurate as of their as-of dates.',
      invalidation: 'A cited source is superseded, amended, or contradicted by newer evidence.',
      evidenceRefs: refs,
    });
  }
  if (!conn.db.myMessage.id.find(recordId('', thesisId, '.claim'))) await conn.reducers.postMessage({
    id: recordId('', thesisId, '.claim'), runId, taskId: task.id, symbol: task.symbol, recipientRole: 'coordinator',
    kind: 'claim', body: `Thesis ${thesisId} published for ${task.symbol}`, evidenceRef: thesisId,
  });
  return { ok: true, text: thesisId };
}

// Placeholder skeptic: rule-based evidence-quality checks against the thesis's citations.
async function reviewThesis(conn: DbConnection, task: Task): Promise<Outcome> {
  const thesisId = conn.db.myTask.id.find(task.dependsOn)?.result ?? '';
  const thesis = conn.db.myThesis.id.find(thesisId);
  if (!thesis) return { ok: false, text: `Thesis ${thesisId || '(none)'} for dependency ${task.dependsOn} not found` };
  if (thesis.symbol !== task.symbol) return { ok: false, text: `Thesis ${thesisId} is for ${thesis.symbol}, not ${task.symbol}` };
  const existing = conn.db.myMessage.id.find(recordId('', task.id, '.challenge'));
  if (existing) {
    if (!existing.body.startsWith('{')) return { ok: true, text: existing.body };
    const data = JSON.parse(existing.body) as { verdict: string; objections: string[] };
    return { ok: true, text: clip(`${data.verdict === 'supports' ? 'pass' : 'concerns'} (${data.verdict}): ${data.objections[0] ?? 'no objections'}`) };
  }
  const concerns: string[] = [];
  const refs = thesis.evidenceRefs.split(',').filter(Boolean);
  const nowMicros = BigInt(Date.now()) * 1000n;
  let sourceCount = 0;
  for (const ref of refs) {
    const source = conn.db.mySource.id.find(ref);
    const fact = conn.db.myFact.id.find(ref);
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
    id: recordId('', task.id, '.challenge'), runId, taskId: task.id, symbol: task.symbol, recipientRole: 'coordinator',
    kind: 'challenge', body, evidenceRef: thesisId,
  });
  return { ok: true, text: body };
}

// Placeholder coordinator: queues a skeptic review for each thesis, then records a decision from the review.
function coordinate(conn: DbConnection): void {
  if (positionReviewDays) queuePositionReviews(conn);
  for (const task of runTasks(conn)) {
    if (task.status !== 'completed') continue;
    if (task.kind === 'thesis' || task.kind === 'position_review') {
      const specialists = [teamValuation ? 'valuation' : '', teamPortfolio ? 'portfolio' : ''].filter(Boolean);
      for (const kind of specialists) {
        const id = recordId(`${kind}.`, task.id);
        if (conn.db.myTask.id.find(id)) continue;
        void once(`coord:${id}`, async () => {
          await conn.reducers.createTask({ id, runId, symbol: task.symbol, kind,
            objective: `${kind} analysis of thesis ${task.result}`, role: kind, dependsOn: task.id });
          console.log(`Queued ${id}`);
        });
      }
      if (specialists.some(kind => {
        const state = conn.db.myTask.id.find(recordId(`${kind}.`, task.id))?.status;
        return state !== 'completed' && state !== 'failed';
      })) continue;
      const reviewId = recordId('review.', task.id);
      if (conn.db.myTask.id.find(reviewId)) continue;
      void once(`coord:${reviewId}`, async () => {
        await conn.reducers.createTask({
          id: reviewId, runId, symbol: task.symbol, kind: 'review',
          objective: `Challenge thesis ${task.result}`, role: 'skeptic', dependsOn: task.id,
        });
        console.log(`Queued ${reviewId}`);
      });
    } else if (task.kind === 'review') {
      const thesisId = conn.db.myTask.id.find(task.dependsOn)?.result ?? '';
      if (!conn.db.myThesis.id.find(thesisId)) continue;
      const decisionId = recordId('decision.', thesisId);
      const messageId = recordId('', decisionId, '.msg');
      if (conn.db.myMessage.id.find(messageId)) continue;
      void once(`coord:${decisionId}`, async () => {
        if (ask) {
          const controller = new AbortController();
          controllers.set(decisionId, controller);
          try { return await modelDecide(ask, conn, task, thesisId, runId, { decisionId, messageId }, controller.signal,
            { valuation: teamValuation, portfolio: teamPortfolio }); }
          finally { if (controllers.get(decisionId) === controller) controllers.delete(decisionId); }
        }
        const passed = task.result.startsWith('pass');
        // Phase 1 has no valuation model, so the coordinator never decides to trade.
        const existing = [...conn.db.myDecision.iter()].find(row => row.thesisId === thesisId);
        const outcome = existing?.outcome ?? (passed ? 'abstain' : 'revise');
        const rationale = existing?.rationale ?? (passed
          ? 'Skeptic found no evidence-quality issues, but no valuation model exists yet; abstaining.'
          : `Skeptic review raised ${task.result}`);
        if (!existing) {
          await conn.reducers.recordDecision({ id: decisionId, thesisId, outcome, rationale: clip(rationale) });
        }
        const proposal = conn.db.myTradeProposal.id.find(recordId('proposal.', thesisId));
        if (outcome === 'trade' && !proposal) throw new Error(`Trade decision ${decisionId} has no durable proposal`);
        const proposalNote = proposal
          ? ` Proposed ${proposal.side} ${proposal.quantity} ${proposal.symbol} ${proposal.orderType}` +
            `${proposal.limitPrice ? ` @ ${proposal.limitPrice}` : ''} as ${proposal.id}, pending risk review.`
          : '';
        await conn.reducers.postMessage({
          id: messageId, runId, taskId: task.id, symbol: task.symbol, recipientRole: '',
          kind: 'decision', body: clip(`${outcome} on ${thesisId}: ${rationale}${proposalNote}`), evidenceRef: thesisId,
        });
        console.log(`Decided ${thesisId}: ${outcome}`);
      });
    }
  }
}

function queuePositionReviews(conn: DbConnection): void {
  try {
    const policyId = conn.db.myRunConfig.runId.find(runId)?.policyId ?? '';
    const policy = policyId ? conn.db.myRiskPolicy.id.find(policyId) : undefined;
    if (!policy) return;
    const snapshot = [...conn.db.myAccountSnapshot.iter()].filter(row => row.accountId === policy.accountId)
      .sort((a, b) => Number(b.capturedAt.microsSinceUnixEpoch - a.capturedAt.microsSinceUnixEpoch))[0];
    if (!snapshot || Date.now() - snapshot.capturedAt.toDate().getTime() > 15 * 60_000 ||
        snapshot.accountStatus !== 'ACTIVE') return;
    const proposals = [...conn.db.myTradeProposal.iter()].filter(row => row.runId === runId).map(row => ({
      id: row.id, runId: row.runId, thesisId: row.thesisId, symbol: row.symbol, side: row.side,
      createdAt: row.createdAt.toDate(), thesisTaskId: conn.db.myThesis.id.find(row.thesisId)?.taskId ?? '',
    }));
    const orders = [...conn.db.myPaperOrder.iter()].map(row => ({ id: row.id, proposalId: row.proposalId }));
    const fills = [...conn.db.myFill.iter()].map(row => ({ id: row.id, orderId: row.orderId,
      quantity: Number(row.quantity), price: Number(row.price), at: row.filledAt.toDate() }));
    const markers = [...conn.db.myFact.iter()].filter(row => row.metric === 'filing_update_review' && row.value === 'review_required')
      .map(row => ({ id: row.id, symbol: row.symbol, asOf: row.createdAt.toDate() }));
    const quotes = [...conn.db.myMarketObservation.iter()].map(row => ({ id: row.id, symbol: row.symbol,
      bid: Number(row.bidPrice), asOf: row.asOf.toDate() }));
    const tasks = runTasks(conn).map(row => ({ id: row.id, status: row.status }));
    const maxPositionNotional = Number(JSON.parse(policy.policyJson).maxPositionNotional);
    const planned = planPositionReviews({ runId, now: new Date(), config: {
      everyDays: positionReviewDays, priceMovePct: positionReviewPriceMovePct,
    }, proposals, orders, fills, positions: parsePositions(snapshot.positionsJson), markers, quotes, tasks,
      maxPositionNotional: Number.isFinite(maxPositionNotional) ? maxPositionNotional : undefined });
    for (const task of planned) void once(`coord:${task.id}`, async () => {
      await conn.reducers.createTask(task);
      console.log(`Queued position review ${task.id}`);
    });
  } catch (error) {
    console.error(`Position review scan skipped: ${String(error)}`);
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
  const generation = ++connectionGeneration;
  console.log(`Connecting ${name} to ${host}/${database}`);
  connection = DbConnection.builder()
    .withUri(host)
    .withDatabaseName(database)
    .withToken(loadToken(tokenFile))
    .onConnect((conn, identity, token) => {
      if (generation !== connectionGeneration || stopped) { conn.disconnect(); return; }
      attempts = 0;
      saveToken(tokenFile, token);
      console.log(`Agent ${name} identity: ${identity.toHexString()}`);
      const rescan = () => scan(conn);
      conn.db.myTask.onInsert((_ctx, row) => { console.log(`Task ${row.id}: ${row.status}`); rescan(); });
      conn.db.myTask.onUpdate((_ctx, _old, row) => { console.log(`Task ${row.id}: ${row.status}`); rescan(); });
      conn.db.myMessage.onInsert((_ctx, row) => {
        console.log(`Message ${row.id} [${row.kind}${row.recipientRole ? ` → ${row.recipientRole}` : ''}]: ${row.body}`);
        rescan();
      });
      conn.db.myAgent.onInsert(rescan);
      conn.db.myAgent.onUpdate(rescan);
      conn.db.myThesis.onInsert(rescan);
      conn.db.myFill.onInsert(rescan);
      conn.db.myAccountSnapshot.onInsert(rescan);
      conn.db.myFact.onInsert(rescan);
      conn.db.myMarketObservation.onInsert(rescan);
      conn.db.myRun.onUpdate(rescan);
      conn.db.myRun.onDelete(rescan);
      conn.db.myAgent.onDelete(rescan);
      conn.subscriptionBuilder()
        .onApplied(() => {
          if (generation !== connectionGeneration || stopped) return;
          ready = true;
          console.log(`Subscription ready for run ${runId} (role: ${myRole(conn) ?? 'not granted'})`);
          void conn.reducers.heartbeat({}).catch(error => console.log(`Heartbeat awaits grant: ${String(error)}`));
          heartbeatTimer = setInterval(() => {
            void conn.reducers.heartbeat({}).catch(error => console.error('Heartbeat failed:', error));
            scan(conn);
          }, 15_000);
          scan(conn);
        })
        .onError(ctx => {
          console.error('Subscription failed:', ctx);
          try { conn.disconnect(); } catch { /* Connection may already be closed. */ }
          scheduleReconnect('Subscription ended', generation);
        })
        .subscribe([
          'SELECT * FROM my_agent',
          'SELECT * FROM my_run',
          `SELECT * FROM my_task WHERE run_id = '${runId}'`,
          `SELECT * FROM my_message WHERE run_id = '${runId}'`,
          `SELECT * FROM my_source WHERE run_id = '${runId}'`,
          `SELECT * FROM my_thesis WHERE run_id = '${runId}'`,
          'SELECT * FROM my_fact',
          'SELECT * FROM my_decision',
          'SELECT * FROM my_trade_proposal',
          'SELECT * FROM my_paper_order',
          'SELECT * FROM my_fill',
          'SELECT * FROM my_market_observation',
          'SELECT * FROM my_decision_input',
          'SELECT * FROM my_run_config',
          'SELECT * FROM my_risk_policy',
          'SELECT * FROM my_account_snapshot',
          'SELECT * FROM my_inference_attempt',
        ]);
    })
    .onConnectError((_ctx, error) => scheduleReconnect(error, generation))
    .onDisconnect((_ctx, error) => scheduleReconnect(error, generation))
    .build();
}

const stop = () => {
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  for (const controller of controllers.values()) controller.abort();
  connection?.disconnect();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

connect();
