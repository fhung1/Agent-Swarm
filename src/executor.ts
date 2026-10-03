import { Timestamp } from 'spacetimedb';
import { DbConnection } from './module_bindings/index.js';
import { credentialsFromEnv, getAccount, getPositions, getOpenOrders, object, textField, type AlpacaCredentials, type JsonObject } from './alpaca-client.js';
import { cancelOrder, getFills, getOrder, getOrderByClientId, submitOrder } from './alpaca-orders.js';
import {
  TERMINAL, classifySubmitFailure, clientOrderIdFor, filledQuantity, newFills, nextStatus, orderRequestFor,
  paperOrderIdFor,
} from './agents/execution.js';
import { recordId } from './ids.js';
import { submissionBlock } from './agents/submission.js';
import { parseRiskPolicy, pendingIntentsFor } from './agents/risk-review.js';
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
const cancelRequested = new Set<string>();

type PaperOrderRow = { id: string; proposalId: string; clientOrderId: string; alpacaOrderId: string; status: string; submittedAt: Timestamp };
type CancelRequestRow = { orderId: string; status: string; reason: string; detail: string };

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
  // A fill may arrive in the first POST response. Bind the broker identity before recording its activities.
  if(!order.alpacaOrderId)await conn.reducers.updatePaperOrder({id:order.id,alpacaOrderId,status:order.status});
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
  const blocked = beforeSubmission(conn, order, account);
  if (blocked) { console.log(`${order.id}: new submission blocked: ${blocked}`); return; }
  const prior=[...conn.db.myPaperSubmission.iter()].filter(a=>a.orderId===order.id);
  const attemptId=recordId('submit.',`${order.id}.${prior.length+1}`);
  try{await conn.reducers.beginPaperSubmission({id:attemptId,orderId:order.id,expectedAttempts:prior.length});}
  catch(error){console.log(`${order.id}: authoritative submission blocked: ${String(error)}`);return;}
  let broker:JsonObject;
  try {
    broker = await submitOrder(credentials!, orderRequestFor(proposal, order.clientOrderId));
  } catch (error) {
    const kind = classifySubmitFailure(error);
    await conn.reducers.finishPaperSubmission({id:attemptId,status:kind,details:clip(String(error),2000)});
    if (kind === 'refused') {
      // A refused resubmission may be the broker rejecting a duplicate of an order that already exists.
      const existing = await getOrderByClientId(credentials!, order.clientOrderId);
      if (existing) return recordBrokerState(conn, order, existing, issues);
      if (prior.length > 0) { issues.push(`${order.id}: refusal after earlier attempts remains uncertain until reconciled`); return; }
      return reject(conn, order, account, String((error as Error).message));
    }
    // duplicate: the order exists under our client order ID; the next lookup records it.
    // retry and uncertain: nothing is assumed; the next cycle looks the order up before trying again.
    if (kind !== 'duplicate') issues.push(`${order.id}: submission ${kind}: ${String((error as Error).message).slice(0, 200)}`);
    console.log(`Submission of ${order.id} ${kind}: ${String(error)}`);
    return;
  }
  await conn.reducers.finishPaperSubmission({id:attemptId,status:'accepted',details:`Broker returned ${String(broker.id??'an order')}; fills require separate reconciliation`});
  console.log(`Submitted ${order.id} as ${order.clientOrderId}: ${proposal.side} ${proposal.quantity} ${proposal.symbol} ${proposal.orderType}`);
  await recordBrokerState(conn, order, broker, issues);
}

// An order reserved in the ledger but without a broker ID: find it by client order ID, or (re)submit it.
async function settle(conn: DbConnection, order: PaperOrderRow, account: string, issues: string[]): Promise<void> {
  const broker = await getOrderByClientId(credentials!, order.clientOrderId);
  if (broker) return recordBrokerState(conn, order, broker, issues);
  const attempts=[...conn.db.myPaperSubmission.iter()].filter(a=>a.orderId===order.id).sort((a,b)=>b.attempt-a.attempt);
  if (attempts[0] && Date.now() - attempts[0].startedAt.toDate().getTime() < ABSENCE_GRACE_MS) return;
  if (attempts.length >= MAX_SUBMIT_ATTEMPTS) {
    issues.push(`${order.id}: submission remains uncertain after ${MAX_SUBMIT_ATTEMPTS} attempts; retaining exposure for reconciliation`);
    return;
  }
  await submit(conn, order, account, issues);
}

async function processOperatorCancel(
  conn: DbConnection, order: PaperOrderRow, request: CancelRequestRow, issues: string[],
): Promise<void> {
  if (TERMINAL.has(order.status)) {
    if (request.status === 'requested' || request.status === 'broker_requested') {
      await conn.reducers.updateOrderCancel({
        orderId: order.id, status: 'resolved', detail: `Broker order reached terminal state ${order.status}`,
      });
    }
    return;
  }
  if (request.status !== 'requested' || !order.alpacaOrderId) return;
  try {
    const accepted = await cancelOrder(credentials!, order.alpacaOrderId);
    if (accepted) {
      await conn.reducers.updateOrderCancel({
        orderId: order.id, status: 'broker_requested', detail: 'Alpaca accepted the cancellation request',
      });
      console.log(`Operator cancellation requested for ${order.id}: ${request.reason}`);
      return;
    }
    const broker = await getOrder(credentials!, order.alpacaOrderId);
    if (!broker) {
      await conn.reducers.updateOrderCancel({ orderId: order.id, status: 'refused', detail: 'Broker order was not found' });
      return;
    }
    await recordBrokerState(conn, order, broker, issues);
    const brokerStatus = String(broker.status ?? 'unknown');
    const mapped = nextStatus(order.status, brokerStatus);
    if (mapped === 'pending_cancel') {
      await conn.reducers.updateOrderCancel({
        orderId: order.id, status: 'broker_requested', detail: 'Broker reports cancellation pending',
      });
    } else if (!mapped || !TERMINAL.has(mapped)) {
      await conn.reducers.updateOrderCancel({
        orderId: order.id, status: 'refused', detail: `Alpaca refused cancellation while order was ${brokerStatus}`,
      });
    }
  } catch (error) {
    issues.push(`${order.id}: cancellation attempt failed: ${String((error as Error).message ?? error).slice(0, 200)}`);
  }
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
  if (!ready || connection !== conn || !conn.isActive || cycling || [...conn.db.myAgent.iter()].find(a => a.identity.equals(conn.identity!))?.role !== 'executor') return;
  cycling = true;
  const issues: string[] = [];
  try {
    const account = await brokerAccountId();
    const runs = new Map([...conn.db.myRun.iter()].map(r => [r.id, r.status]));
    const proposals = new Map([...conn.db.myTradeProposal.iter()].map(p => [p.id, p]));
    const orders = [...conn.db.myPaperOrder.iter()];
    const cancellationRequests = new Map([...conn.db.myOrderCancelRequest.iter()].map(request => [request.orderId, request]));
    for (const order of orders) {
      const operatorCancel = cancellationRequests.get(order.id);
      if (operatorCancel) await processOperatorCancel(conn, order, operatorCancel, issues);
      if (TERMINAL.has(order.status)) continue;
      const reservation = [...conn.db.myRiskReservation.iter()].find(r => r.proposalId === order.proposalId);
      if (reservation && reservation.accountId !== account) { issues.push(`${order.id}: reserved for account ${reservation.accountId}, credentials are for ${account}`); continue; }
      try {
        if (!order.alpacaOrderId) {
          const found=await getOrderByClientId(credentials!,order.clientOrderId);
          if(found)await recordBrokerState(conn,order,found,issues);
          continue;
        }
        // Pausing or closing a run cancels its open orders; the broker's answer arrives through the next refresh.
        const runStatus = runs.get(proposals.get(order.proposalId)?.runId ?? '');
        if (runStatus !== 'active' && !cancelRequested.has(order.id)) {
          const accepted = await cancelOrder(credentials!, order.alpacaOrderId);
          cancelRequested.add(order.id);
          console.log(`Run ${runStatus ?? 'unknown'}: cancel ${order.id} ${accepted ? 'requested' : 'refused (no longer cancelable)'}`);
        }
        const broker = await getOrder(credentials!, order.alpacaOrderId);
        if (!broker) { issues.push(`${order.id}: broker order ${order.alpacaOrderId} not found`); continue; }
        await recordBrokerState(conn, order, broker, issues);
      } catch (error) {
        issues.push(`${order.id}: ${String((error as Error).message ?? error).slice(0, 200)}`);
      }
    }
    // Reconcile before every new submission, including cash, quantities and non-swarm broker orders.
    const [rawAccount,positions,openOrders]=await Promise.all([getAccount(credentials!),getPositions(credentials!),getOpenOrders(credentials!)]);
    const currentAccount=object(rawAccount,'account');
    if(textField(currentAccount,'id')!==account)throw new Error('Paper credentials changed account during reconciliation');
    if(currentAccount.status!=='ACTIVE'||currentAccount.trading_blocked===true)issues.push('Paper account is inactive or trading blocked');
    await conn.reducers.reconcilePaperAccount({id:recordId('recon.',`${account}.${Date.now()}`),accountId:account,cash:textField(currentAccount,'cash'),positionsJson:JSON.stringify(positions),openOrdersJson:JSON.stringify(openOrders),issues:clip(issues.join('; '))});
    const check=[...conn.db.myAccountCheck.iter()].find(c=>c.accountId===account);
    if(check?.status!=='matched'){console.log(`New submissions blocked: ${check?.details??'account check missing'}`);return;}
    await reserveNew(conn,account);
    for(const order of [...conn.db.myPaperOrder.iter()])if(!order.alpacaOrderId&&!TERMINAL.has(order.status)){
      try{await settle(conn,order,account,issues);}catch(error){issues.push(`${order.id}: ${String(error)}`);}
    }
    if(issues.length)await conn.reducers.recordReconciliation({id:recordId('recon.',`${account}.${Date.now()}.submission`),accountId:account,status:'mismatch',details:clip(issues.join('; '))});
  } catch (error) {
    console.error(`Executor cycle failed: ${String(error)}`);
  } finally {
    cycling = false;
  }
}

function beforeSubmission(conn: DbConnection, order: PaperOrderRow, account: string): string | undefined {
  try {
    const proposal = [...conn.db.myTradeProposal.iter()].find(p => p.id === order.proposalId);
    const reservation = [...conn.db.myRiskReservation.iter()].find(r => r.proposalId === order.proposalId);
    if (!proposal || !reservation) return 'Proposal or reservation missing';
    const accountCheck=[...conn.db.myAccountCheck.iter()].find(c=>c.accountId===account);
    if(accountCheck?.status!=='matched')return 'Full account reconciliation is pending or mismatched';
    const config = [...conn.db.myRunConfig.iter()].find(c => c.runId === proposal.runId);
    const policyRow = [...conn.db.myRiskPolicy.iter()].find(p => p.id === config?.policyId);
    const snapshot = [...conn.db.myAccountSnapshot.iter()].filter(s => s.accountId === account)
      .sort((a,b) => Number(b.capturedAt.microsSinceUnixEpoch - a.capturedAt.microsSinceUnixEpoch))[0];
    const quotes = [...conn.db.myMarketObservation.iter()].filter(q => q.snapshotId === snapshot?.id);
    const quote = quotes.find(q => q.symbol === proposal.symbol);
    const clock = [...conn.db.myMarketClock.iter()].find(c => c.accountId === account);
    const risk = [...conn.db.myRiskDecision.iter()].find(r => r.proposalId === proposal.id);
    if (!policyRow || !snapshot || !quote || !clock || policyRow.accountId !== account) return 'Current risk inputs missing or account mismatch';
    const now = new Date();
    const proposals = new Map([...conn.db.myTradeProposal.iter()].map(p => [p.id,{...p,createdAt:p.createdAt.toDate()}]));
    const decisions = new Map([...conn.db.myRiskDecision.iter()].map(r => [r.proposalId,{...r,expiresAt:r.expiresAt.toDate()}]));
    const orders = new Map([...conn.db.myPaperOrder.iter()].map(o => [o.proposalId,o]));
    const reconciliation = [...conn.db.myReconciliation.iter()].filter(r => r.accountId === account)
      .sort((a,b) => Number(b.capturedAt.microsSinceUnixEpoch-a.capturedAt.microsSinceUnixEpoch))[0];
    const clockAge = now.getTime()-clock.asOf.toDate().getTime();
    return submissionBlock({ connected:ready && connection === conn && conn.isActive,
      authorized:[...conn.db.myAgent.iter()].some(a => a.identity.equals(conn.identity!) && a.role==='executor'),
      accountId:account,reservationAccountId:reservation.accountId,policyId:policyRow.id,snapshotId:snapshot.id,quoteId:quote.id,
      reconciliationStatus:reconciliation?.status,risk:risk && {...risk,expiresAt:risk.expiresAt.toDate()},policy:parseRiskPolicy(policyRow.policyJson),
      input:{ proposal:{...proposal,createdAt:proposal.createdAt.toDate()}, runStatus:[...conn.db.myRun.iter()].find(r=>r.id===proposal.runId)?.status??'',
        now,marketOpen:clock.isOpen && clockAge>=0 && clockAge<=60000, quote:{...quote,asOf:quote.asOf.toDate()},
        quotes:quotes.map(q=>({...q,asOf:q.asOf.toDate()})),account:{...snapshot,status:snapshot.accountStatus,capturedAt:snapshot.capturedAt.toDate()},
        pendingIntents:pendingIntentsFor(proposal.id,account,[...conn.db.myRiskReservation.iter()],proposals,decisions,orders,now) } });
  } catch(error) { return `Cannot validate submission: ${String(error)}`; }
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
          'SELECT * FROM my_risk_reservation', 'SELECT * FROM my_paper_order', 'SELECT * FROM my_order_cancel_request', 'SELECT * FROM my_fill',
          'SELECT * FROM my_run_config', 'SELECT * FROM my_risk_policy', 'SELECT * FROM my_account_snapshot',
          'SELECT * FROM my_market_observation', 'SELECT * FROM my_market_clock', 'SELECT * FROM my_reconciliation',
          'SELECT * FROM my_paper_submission','SELECT * FROM my_account_ledger','SELECT * FROM my_account_check',
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
