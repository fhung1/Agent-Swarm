import { Timestamp } from 'spacetimedb';
import { DbConnection } from './module_bindings/index.js';
import { credentialsFromEnv, getAccount, getOpenOrders, object, textField, type AlpacaCredentials, type JsonObject } from './alpaca-client.js';
import { cancelOrder, getFills, getOrder, getOrderByClientId, submitOrder } from './alpaca-orders.js';
import {
  TERMINAL, classifySubmitFailure, clientOrderIdFor, filledQuantity, newFills, nextStatus, orderRequestFor,
  paperOrderIdFor,
} from './agents/execution.js';
import { recordId } from './ids.js';
import { defaultTokenFile, loadToken, saveToken } from './tokens.js';

// Paper executor: submits risk-passed proposals to Alpaca's paper trading API and keeps the order ledger reconciled.
// No human approves orders; a fresh risk pass from the risk broker is the only requirement. Each proposal gets one
// deterministic client order ID, so retries after timeouts or restarts can never place a second order.
//
// One-time setup (owner CLI), after `node dist/executor.js --register` prints the identity:
//   spacetime call --server local quant-swarm grant_agent <EXECUTOR_IDENTITY> executor
//   spacetime call --server local quant-swarm grant_run_access <EXECUTOR_IDENTITY> <RUN_ID>
//   spacetime call --server local quant-swarm grant_account_access <EXECUTOR_IDENTITY> <ALPACA_ACCOUNT_ID>

const name = process.env.AGENT_NAME ?? 'executor-1';
const host = process.env.SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const database = process.env.SPACETIMEDB_DB_NAME ?? 'quant-swarm';
const tokenFile = process.env.AGENT_TOKEN_FILE ?? defaultTokenFile(name);
const registerOnly = process.argv.includes('--register');
const CYCLE_MS = 10_000;
// A lookup that finds nothing right after a submission can be broker lag; only later does absence mean "never placed".
const ABSENCE_GRACE_MS = 60_000;
const MAX_SUBMIT_ATTEMPTS = 3;
const ACCOUNT_CHECK_MS = 5 * 60_000;

if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(name)) throw new Error('AGENT_NAME has invalid characters');
let credentials: AlpacaCredentials | undefined;
try {
  credentials = registerOnly ? undefined : credentialsFromEnv();
} catch (error) {
  console.error(`Executor cannot start: ${(error as Error).message}. Set ALPACA_API_KEY and ALPACA_API_SECRET (paper keys).`);
  process.exit(1);
}

let connection: DbConnection | undefined;
let retryTimer: NodeJS.Timeout | undefined;
let cycleTimer: NodeJS.Timeout | undefined;
let attempts = 0;
let ready = false;
let stopped = false;
let cycling = false;
let accountId: string | undefined;
let accountCheckedAt = 0;
// Per-process submission bookkeeping. After a restart the deterministic client order ID makes resubmission safe.
const submits = new Map<string, { attempts: number; lastAt: number }>();
const cancelRequested = new Set<string>();
let lastReconciliation: string | undefined;

type PaperOrderRow = { id: string; proposalId: string; clientOrderId: string; alpacaOrderId: string; status: string; submittedAt: Timestamp };

// Fill totals are fixed-point with 6 decimals.
function formatUnits(units: bigint): string {
  const text = units.toString().padStart(7, '0');
  return `${text.slice(0, -6)}.${text.slice(-6)}`.replace(/\.?0+$/, '');
}

function clip(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function brokerAccountId(): Promise<string> {
  if (!accountId || Date.now() - accountCheckedAt > ACCOUNT_CHECK_MS) {
    accountId = textField(object(await getAccount(credentials!), 'account'), 'id', 'account ID');
    accountCheckedAt = Date.now();
  }
  return accountId;
}

async function recordBrokerState(conn: DbConnection, order: PaperOrderRow, broker: JsonObject, issues: string[]): Promise<void> {
  const alpacaOrderId = textField(broker, 'id', 'order ID');
  if (order.alpacaOrderId && order.alpacaOrderId !== alpacaOrderId) {
    issues.push(`${order.id}: broker order ${alpacaOrderId} differs from recorded ${order.alpacaOrderId}`);
    return;
  }
  // Fills first: the module accepts "filled" only once recorded fills add up to the order quantity.
  const recorded = [...conn.db.myFill.iter()].filter(f => f.orderId === order.id);
  const brokerFilled = String(broker.filled_qty ?? '0');
  const brokerTotal = Number(brokerFilled) > 0 ? filledQuantity([brokerFilled]) : 0n;
  if (brokerTotal !== filledQuantity(recorded.map(f => f.quantity))) {
    const recordedIds = new Set(recorded.map(f => f.alpacaActivityId));
    const fills = newFills(await getFills(credentials!, alpacaOrderId), order.id, alpacaOrderId, recordedIds);
    for (const fill of fills) {
      await conn.reducers.recordFill({ ...fill, filledAt: Timestamp.fromDate(fill.filledAt) });
      console.log(`Recorded fill ${fill.alpacaActivityId}: ${fill.quantity} @ ${fill.price} for ${order.id}`);
    }
    // Activities can lag the order's filled_qty; a gap that persists across cycles is a real mismatch.
    const total = filledQuantity([...recorded, ...fills].map(f => f.quantity));
    if (total !== brokerTotal) issues.push(`${order.id}: recorded fills total ${formatUnits(total)} but broker filled_qty is ${brokerFilled}`);
  }
  const status = nextStatus(order.status, String(broker.status ?? ''));
  if (!order.alpacaOrderId || status) {
    // Record the broker identity even when its status is a transient one the ledger does not track.
    await conn.reducers.updatePaperOrder({ id: order.id, alpacaOrderId, status: status ?? order.status });
    console.log(`${order.id}: ${order.status} → ${status ?? order.status} (broker ${broker.status}, ${alpacaOrderId})`);
  } else if (String(broker.status) !== order.status && TERMINAL.has(order.status)) {
    issues.push(`${order.id}: recorded ${order.status} but broker reports ${broker.status}`);
  }
}

async function reject(conn: DbConnection, order: PaperOrderRow, account: string, reason: string): Promise<void> {
  await conn.reducers.updatePaperOrder({ id: order.id, alpacaOrderId: '', status: 'rejected' });
  await conn.reducers.recordReconciliation({
    id: recordId('recon.', `${order.id}.refused`), accountId: account, status: 'resolved',
    details: clip(`${order.id} (${order.clientOrderId}) refused by the broker before an order was created: ${reason}`),
  });
  console.log(`${order.id} rejected: ${reason}`);
}

async function submit(conn: DbConnection, order: PaperOrderRow, account: string, issues: string[]): Promise<void> {
  const proposal = [...conn.db.myTradeProposal.iter()].find(p => p.id === order.proposalId);
  if (!proposal) { issues.push(`${order.id}: proposal ${order.proposalId} not visible`); return; }
  const bookkeeping = submits.get(order.id) ?? { attempts: 0, lastAt: 0 };
  submits.set(order.id, { attempts: bookkeeping.attempts + 1, lastAt: Date.now() });
  try {
    const broker = await submitOrder(credentials!, orderRequestFor(proposal, order.clientOrderId));
    console.log(`Submitted ${order.id} as ${order.clientOrderId}: ${proposal.side} ${proposal.quantity} ${proposal.symbol} ${proposal.orderType}`);
    await recordBrokerState(conn, order, broker, issues);
  } catch (error) {
    const kind = classifySubmitFailure(error);
    if (kind === 'refused') {
      // A refused resubmission may be the broker rejecting a duplicate of an order that already exists.
      const existing = await getOrderByClientId(credentials!, order.clientOrderId);
      if (existing) return recordBrokerState(conn, order, existing, issues);
      return reject(conn, order, account, String((error as Error).message));
    }
    // duplicate: the order exists under our client order ID; the next lookup records it.
    // retry and uncertain: nothing is assumed; the next cycle looks the order up before trying again.
    if (kind !== 'duplicate') issues.push(`${order.id}: submission ${kind}: ${String((error as Error).message).slice(0, 200)}`);
    console.log(`Submission of ${order.id} ${kind}: ${String(error)}`);
  }
}

// An order reserved in the ledger but without a broker ID: find it by client order ID, or (re)submit it.
async function settle(conn: DbConnection, order: PaperOrderRow, account: string, issues: string[]): Promise<void> {
  const broker = await getOrderByClientId(credentials!, order.clientOrderId);
  if (broker) return recordBrokerState(conn, order, broker, issues);
  const bookkeeping = submits.get(order.id);
  const lastAt = bookkeeping?.lastAt ?? order.submittedAt.toDate().getTime();
  if (bookkeeping && Date.now() - lastAt < ABSENCE_GRACE_MS) return; // too soon to treat absence as "never placed"
  if ((bookkeeping?.attempts ?? 0) >= MAX_SUBMIT_ATTEMPTS) {
    return reject(conn, order, account, `no broker order after ${MAX_SUBMIT_ATTEMPTS} submissions`);
  }
  await submit(conn, order, account, issues);
}

async function reserveNew(conn: DbConnection, account: string): Promise<void> {
  const ordered = new Set([...conn.db.myPaperOrder.iter()].map(o => o.proposalId));
  const now = Date.now();
  for (const proposal of conn.db.myTradeProposal.iter()) {
    if (!['risk_passed', 'approved'].includes(proposal.status) || ordered.has(proposal.id)) continue;
    const reservation = [...conn.db.myRiskReservation.iter()].find(r => r.proposalId === proposal.id);
    const risk = [...conn.db.myRiskDecision.iter()].find(d => d.proposalId === proposal.id);
    const run = [...conn.db.myRun.iter()].find(r => r.id === proposal.runId);
    if (!reservation || reservation.accountId !== account || !risk || risk.outcome !== 'pass' ||
        risk.expiresAt.toDate().getTime() <= now || run?.status !== 'active') continue;
    try {
      await conn.reducers.reservePaperOrder({
        id: paperOrderIdFor(proposal.id), proposalId: proposal.id, clientOrderId: clientOrderIdFor(proposal.id),
      });
      console.log(`Reserved ${paperOrderIdFor(proposal.id)} for ${proposal.id}`);
    } catch (error) {
      // A stale pass ("Risk inputs changed", "Risk approval expired") is refreshed by the risk broker; try again later.
      console.log(`Could not reserve ${proposal.id}: ${String(error)}`);
    }
  }
}

async function cycle(conn: DbConnection): Promise<void> {
  if (!ready || cycling || [...conn.db.myAgent.iter()].find(a => a.identity.equals(conn.identity!))?.role !== 'executor') return;
  cycling = true;
  const issues: string[] = [];
  try {
    const account = await brokerAccountId();
    await reserveNew(conn, account);
    const runs = new Map([...conn.db.myRun.iter()].map(r => [r.id, r.status]));
    const proposals = new Map([...conn.db.myTradeProposal.iter()].map(p => [p.id, p]));
    const orders = [...conn.db.myPaperOrder.iter()];
    for (const order of orders) {
      if (TERMINAL.has(order.status)) continue;
      const reservation = [...conn.db.myRiskReservation.iter()].find(r => r.proposalId === order.proposalId);
      if (reservation && reservation.accountId !== account) { issues.push(`${order.id}: reserved for account ${reservation.accountId}, credentials are for ${account}`); continue; }
      try {
        if (!order.alpacaOrderId) { await settle(conn, order, account, issues); continue; }
        // Pausing or closing a run cancels its open orders; the broker's answer arrives through the next refresh.
        const runStatus = runs.get(proposals.get(order.proposalId)?.runId ?? '');
        if (runStatus !== 'active' && !cancelRequested.has(order.id)) {
          cancelRequested.add(order.id);
          const accepted = await cancelOrder(credentials!, order.alpacaOrderId);
          console.log(`Run ${runStatus ?? 'unknown'}: cancel ${order.id} ${accepted ? 'requested' : 'refused (no longer cancelable)'}`);
        }
        const broker = await getOrder(credentials!, order.alpacaOrderId);
        if (!broker) { issues.push(`${order.id}: broker order ${order.alpacaOrderId} not found`); continue; }
        await recordBrokerState(conn, order, broker, issues);
      } catch (error) {
        issues.push(`${order.id}: ${String((error as Error).message ?? error).slice(0, 200)}`);
      }
    }
    // Orders under our client order ID prefix that the ledger does not know about indicate a lost reservation.
    const known = new Set(orders.map(o => o.clientOrderId));
    for (const open of await getOpenOrders(credentials!)) {
      const clientOrderId = String(object(open, 'open order').client_order_id ?? '');
      if (clientOrderId.startsWith('qs-') && !known.has(clientOrderId)) issues.push(`unknown broker order with client order ID ${clientOrderId}`);
    }
    await reconcile(conn, account, issues);
  } catch (error) {
    console.error(`Executor cycle failed: ${String(error)}`);
  } finally {
    cycling = false;
  }
}

// Record a reconciliation whenever the set of discrepancies changes, and once at startup.
async function reconcile(conn: DbConnection, account: string, issues: string[]): Promise<void> {
  const key = [...issues].sort().join('\n');
  if (key === lastReconciliation) return;
  const status = issues.length ? 'mismatch' : lastReconciliation === undefined ? 'matched' : 'resolved';
  await conn.reducers.recordReconciliation({
    id: recordId('recon.', `${account}.${Date.now()}`), accountId: account, status,
    details: clip(issues.length ? issues.join('; ') : 'Ledger matches broker orders and fills'),
  });
  lastReconciliation = key;
  console.log(`Reconciliation ${status}${issues.length ? `: ${issues.join('; ')}` : ''}`);
}

function scheduleReconnect(reason: unknown): void {
  if (stopped || retryTimer) return;
  ready = false;
  if (cycleTimer) clearInterval(cycleTimer);
  console.error('Connection lost:', reason);
  const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts++, 5));
  retryTimer = setTimeout(() => { retryTimer = undefined; connect(); }, delay);
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
      console.log(`Executor ${name} identity: ${identity.toHexString()}`);
      if (registerOnly) {
        console.log('Registered. Grant this identity the executor role, run access, and account access before starting it.');
        stopped = true;
        conn.disconnect();
        return;
      }
      const run = () => void cycle(conn);
      conn.db.myTradeProposal.onUpdate(run);
      conn.db.myRiskDecision.onInsert(run);
      conn.subscriptionBuilder()
        .onApplied(() => {
          ready = true;
          console.log(`Subscription ready (role: ${[...conn.db.myAgent.iter()].find(a => a.identity.equals(conn.identity!))?.role ?? 'not granted'})`);
          cycleTimer = setInterval(run, CYCLE_MS);
          run();
        })
        .onError(ctx => {
          console.error('Subscription failed:', ctx);
          try { conn.disconnect(); } catch { /* Connection may already be closed. */ }
          scheduleReconnect('Subscription ended');
        })
        .subscribe([
          'SELECT * FROM my_agent', 'SELECT * FROM my_run', 'SELECT * FROM my_trade_proposal', 'SELECT * FROM my_risk_decision',
          'SELECT * FROM my_risk_reservation', 'SELECT * FROM my_paper_order', 'SELECT * FROM my_fill',
        ]);
    })
    .onConnectError((_ctx, error) => scheduleReconnect(error))
    .onDisconnect((_ctx, error) => { if (!registerOnly) scheduleReconnect(error); })
    .build();
}

process.on('SIGINT', () => {
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  if (cycleTimer) clearInterval(cycleTimer);
  connection?.disconnect();
  process.exit(0);
});

connect();
