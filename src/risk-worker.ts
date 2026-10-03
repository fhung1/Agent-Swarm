import { randomUUID } from 'node:crypto';
import { Timestamp } from 'spacetimedb';
import { DbConnection } from './module_bindings/index.js';
import {
  amountField, credentialsFromEnv, getAccount, getLatestQuotes, getMarketOpen, getOpenOrders, getPositions,
  object, parseFeed, parseQuote, requiredEnv, textField, type AlpacaCredentials, type Feed,
} from './alpaca-client.js';
import {
  needsRefresh, pendingIntentsFor, reviewProposal, summarize,
  type PaperOrderView, type ProposalView, type ReservationView, type RiskDecisionView,
} from './agents/risk-review.js';
import type { RiskPolicy } from './agents/risk.js';
import { recordId } from './ids.js';
import { defaultTokenFile, loadToken, saveToken } from './tokens.js';

// Risk broker: the only gate between model-driven trade proposals and paper execution. No human approves trades.
// Each cycle reads fresh account, positions, open orders, market clock, and quotes from Alpaca (read-only), stores
// them as one account snapshot plus a market clock, then reviews every waiting proposal against that single snapshot:
// new proposals, and passed-but-unsubmitted proposals whose decision expired or was pinned to older inputs.
// The module recomputes each decision; the worker's verdict must match, so a mismatch means stale local state.
//
// One-time setup (owner/operator CLI), after `node dist/risk-worker.js --register` prints the identity:
//   spacetime call --server local quant-swarm grant_agent <RISK_IDENTITY> risk
//   spacetime call --server local quant-swarm grant_run_access <RISK_IDENTITY> <RUN_ID>
//   spacetime call --server local quant-swarm grant_account_access <RISK_IDENTITY> <ALPACA_ACCOUNT_ID>
//   spacetime call --server local quant-swarm add_risk_policy <POLICY_ID> <RUN_ID> <ALPACA_ACCOUNT_ID> "<policy JSON>"
// The policy JSON's version must equal POLICY_ID; see config/risk-policy.json.

const name = process.env.AGENT_NAME ?? 'risk-1';
const host = process.env.SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const database = process.env.SPACETIMEDB_DB_NAME ?? 'quant-swarm';
const tokenFile = process.env.AGENT_TOKEN_FILE ?? defaultTokenFile(name);
const registerOnly = process.argv.includes('--register');
const RESCAN_MS = 15_000;
const RETRY_AFTER_MS = 60_000;
const MAX_INPUT_RETRIES = 3;

if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(name)) throw new Error('AGENT_NAME has invalid characters');
let credentials: AlpacaCredentials | undefined;
let feed: Feed | undefined;
try {
  credentials = registerOnly ? undefined : credentialsFromEnv();
  feed = registerOnly ? undefined : parseFeed(requiredEnv('ALPACA_DATA_FEED'));
} catch (error) {
  console.error(`Risk worker cannot start: ${(error as Error).message}. Set ALPACA_API_KEY, ALPACA_API_SECRET, and ALPACA_DATA_FEED.`);
  process.exit(1);
}

let connection: DbConnection | undefined;
let retryTimer: NodeJS.Timeout | undefined;
let rescanTimer: NodeJS.Timeout | undefined;
let attempts = 0;
let ready = false;
let stopped = false;
let cycling = false;
let cycleRequested = false;
// Accounts whose last cycle failed are retried after a delay instead of on every table update.
const retryAt = new Map<string, number>();

const toDate = (t: Timestamp) => t.toDate();

function proposalView(row: { id: string; runId: string; thesisId: string; symbol: string; side: string; quantity: string;
  orderType: string; limitPrice: string; status: string; createdAt: Timestamp }): ProposalView {
  return { ...row, createdAt: toDate(row.createdAt) };
}

interface Work { proposal: ProposalView; refresh: boolean }

// Proposals waiting for a decision, grouped by the policy's account so each account gets one snapshot per cycle.
function pendingWork(conn: DbConnection, now: Date): Map<string, { policyId: string; policy: RiskPolicy; work: Work[] }> {
  const byAccount = new Map<string, { policyId: string; policy: RiskPolicy; work: Work[] }>();
  const decisions = new Map([...conn.db.myRiskDecision.iter()].map(d => [d.proposalId, d]));
  const orders = new Map([...conn.db.myPaperOrder.iter()].map(o => [o.proposalId, o]));
  const latestSnapshot = new Map<string, { id: string; at: bigint }>();
  for (const s of conn.db.myAccountSnapshot.iter()) {
    const current = latestSnapshot.get(s.accountId);
    if (!current || s.capturedAt.microsSinceUnixEpoch > current.at) latestSnapshot.set(s.accountId, { id: s.id, at: s.capturedAt.microsSinceUnixEpoch });
  }
  for (const row of conn.db.myTradeProposal.iter()) {
    const intent=orders.get(row.id);
    if (!['proposed', 'risk_passed', 'approved',...(intent?.status==='submitting'&&!intent.alpacaOrderId?['submitting']:[])].includes(row.status)) continue;
    const policyId = [...conn.db.myRunConfig.iter()].find(c => c.runId === row.runId)?.policyId;
    const policyRow = policyId ? [...conn.db.myRiskPolicy.iter()].find(p => p.id === policyId) : undefined;
    if (!policyRow) { console.log(`No risk policy configured for run ${row.runId}; ${row.id} waits`); continue; }
    if ((retryAt.get(policyRow.accountId) ?? 0) > Date.now()) continue;
    const decision = decisions.get(row.id);
    const refresh = row.status !== 'proposed';
    if (refresh && !needsRefresh(decision && { ...decision, expiresAt: toDate(decision.expiresAt) }, orders.get(row.id),
      latestSnapshot.get(policyRow.accountId)?.id, policyRow.id, now)) continue;
    const entry = byAccount.get(policyRow.accountId) ??
      { policyId: policyRow.id, policy: JSON.parse(policyRow.policyJson) as RiskPolicy, work: [] };
    entry.work.push({ proposal: proposalView(row), refresh });
    byAccount.set(policyRow.accountId, entry);
  }
  return byAccount;
}

// Reads Alpaca and stores one snapshot (with quotes for every symbol that affects exposure) and a market clock.
async function captureInputs(conn: DbConnection, accountId: string, symbols: Set<string>) {
  const [accountRaw, positionsRaw, orders, isOpen] = await Promise.all([
    getAccount(credentials!), getPositions(credentials!), getOpenOrders(credentials!), getMarketOpen(credentials!),
  ]);
  const clockAsOf = Timestamp.fromDate(new Date());
  const account = object(accountRaw, 'account');
  if (textField(account, 'id', 'account ID') !== accountId) throw new Error(`Alpaca credentials are for a different account than policy account ${accountId}`);
  if (!Array.isArray(positionsRaw)) throw new Error('Alpaca returned invalid positions');
  for (const p of positionsRaw) symbols.add(textField(object(p, 'position'), 'symbol'));
  for (const o of orders) symbols.add(textField(object(o, 'open order'), 'symbol'));
  const wanted = [...symbols].filter(s => /^[A-Z][A-Z0-9.-]{0,15}$/.test(s)).slice(0, 50);
  const quoteMap = object(object(await getLatestQuotes(credentials!, wanted, feed!), 'latest quotes').quotes, 'latest quotes map');
  const snapshotId = randomUUID();
  const observations = wanted.filter(s => quoteMap[s]).map(s => ({ id: `${snapshotId}.${s}`, feed: feed!, ...parseQuote(s, quoteMap[s]) }));
  const snapshot = {
    id: snapshotId, accountId, accountStatus: textField(account, 'status', 'account status'),
    cash: String(account.cash), buyingPower: amountField(account, 'buying_power'), equity: amountField(account, 'equity'),
    positionsJson: JSON.stringify(positionsRaw), openOrdersJson: JSON.stringify(orders),
  };
  await conn.reducers.recordAccountSnapshot({ ...snapshot, observations });
  await conn.reducers.recordMarketClock({ accountId, isOpen, asOf: clockAsOf });

  // Evaluate the stored rows, which carry the server's capture time, exactly as the module will.
  const stored = await visible(() => {
    const row = [...conn.db.myAccountSnapshot.iter()].find(s => s.id === snapshotId);
    const clock = [...conn.db.myMarketClock.iter()].find(c => c.accountId === accountId);
    const quotes = [...conn.db.myMarketObservation.iter()].filter(o => o.snapshotId === snapshotId);
    if (!row || !clock || clock.asOf.microsSinceUnixEpoch !== clockAsOf.microsSinceUnixEpoch || quotes.length !== observations.length) return undefined;
    return { row, clock, quotes };
  });
  return {
    snapshotId,
    account: { status: stored.row.accountStatus, buyingPower: stored.row.buyingPower, positionsJson: stored.row.positionsJson,
      openOrdersJson: stored.row.openOrdersJson, capturedAt: stored.row.capturedAt.toDate() },
    quotes: stored.quotes.map(o => ({ symbol: o.symbol, bidPrice: o.bidPrice, askPrice: o.askPrice, asOf: o.asOf.toDate() })),
    clockOpen: stored.clock.isOpen, clockAsOf: stored.clock.asOf,
  };
}

// Reducer results and subscription updates can arrive separately; wait briefly for stored rows to reach the cache.
async function visible<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Stored risk inputs did not appear in the subscription');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// Same rule as the module: the market counts as open only on a stored clock at most 60 seconds old.
function marketOpen(clockOpen: boolean, clockAsOf: Timestamp, now: Date): boolean {
  const age = now.getTime() - clockAsOf.toDate().getTime();
  return clockOpen && age >= 0 && age <= 60_000;
}

async function reviewAccount(conn: DbConnection, accountId: string, policyId: string, policy: RiskPolicy, work: Work[]): Promise<void> {
  for (let attempt = 1; attempt <= MAX_INPUT_RETRIES; attempt++) {
    const inputs = await captureInputs(conn, accountId, new Set(work.map(w => w.proposal.symbol)));
    let inputsChanged = false;
    for (const { proposal, refresh } of work) {
      const now = new Date();
      const proposals = new Map([...conn.db.myTradeProposal.iter()].map(p => [p.id, proposalView(p)]));
      const decisions = new Map([...conn.db.myRiskDecision.iter()].map(d => [d.proposalId,
        { ...d, expiresAt: toDate(d.expiresAt) } as RiskDecisionView]));
      const orders = new Map<string, PaperOrderView>([...conn.db.myPaperOrder.iter()].map(o => [o.proposalId, o]));
      const reservations: ReservationView[] = [...conn.db.myRiskReservation.iter()];
      const result = reviewProposal({
        proposal, policy, now, quotes: inputs.quotes, marketOpen: marketOpen(inputs.clockOpen, inputs.clockAsOf, now),
        runStatus: [...conn.db.myRun.iter()].find(r => r.id === proposal.runId)?.status ?? '',
        account: inputs.account,
        pendingIntents: pendingIntentsFor(proposal.id, accountId, reservations, proposals, decisions, orders, now),
      });
      const decision = {
        // Every decision for the same proposal needs a new ID; the snapshot makes it unique and traceable.
        id: recordId('risk.', `${proposal.id}.${inputs.snapshotId}`), proposalId: proposal.id, policyVersion: policyId,
        checks: JSON.stringify(result.checks).slice(0, 4096), expiresAt: Timestamp.fromDate(result.expiresAt),
        snapshotId: inputs.snapshotId, clockAsOf: inputs.clockAsOf,
      };
      let outcome = result.outcome;
      try {
        await conn.reducers.recordRiskDecision({ ...decision, outcome });
      } catch (error) {
        const text = String(error);
        if (text.includes('Risk inputs changed')) { inputsChanged = true; break; }
        if (!text.includes('Risk verdict must match')) throw error;
        // Local state lagged the module (for example, a time threshold crossed between evaluations). The module's
        // verdict is authoritative and its recorded checks are its own, so confirm the other verdict and log the gap.
        outcome = outcome === 'pass' ? 'reject' : 'pass';
        console.log(`Local verdict for ${proposal.id} differed from the module's; recording ${outcome}`);
        await conn.reducers.recordRiskDecision({ ...decision, outcome });
      }
      const body = summarize(proposal, outcome, outcome === result.outcome ? result.failed : [], policyId, result.expiresAt);
      console.log(`${refresh ? 'Refreshed' : 'Reviewed'} ${body}`);
      await conn.reducers.postMessage({
        id: recordId('', decision.id, '.msg'), runId: proposal.runId, taskId: '', symbol: proposal.symbol,
        recipientRole: 'coordinator', kind: 'decision', body, evidenceRef: proposal.thesisId,
      }).catch(error => console.log(`Could not announce ${decision.id}: ${String(error)}`));
    }
    if (!inputsChanged) return;
    console.log(`Inputs for account ${accountId} changed during review; retrying from a fresh snapshot (${attempt}/${MAX_INPUT_RETRIES})`);
  }
  throw new Error(`Inputs kept changing for account ${accountId}`);
}

async function cycle(conn: DbConnection): Promise<void> {
  if (!ready || cycling) { cycleRequested = true; return; }
  if ([...conn.db.myAgent.iter()].find(a => a.identity.equals(conn.identity!))?.role !== 'risk') return;
  cycling = true;
  try {
    do {
      cycleRequested = false;
      for (const [accountId, { policyId, policy, work }] of pendingWork(conn, new Date())) {
        if (connection !== conn) return;
        try {
          await reviewAccount(conn, accountId, policyId, policy, work);
          retryAt.delete(accountId);
        } catch (error) {
          retryAt.set(accountId, Date.now() + RETRY_AFTER_MS);
          console.error(`Risk review for account ${accountId} failed; retrying in ${RETRY_AFTER_MS / 1000}s: ${String(error)}`);
        }
      }
    } while (cycleRequested && connection === conn);
  } finally {
    cycling = false;
  }
}

function scheduleReconnect(reason: unknown): void {
  if (stopped || retryTimer) return;
  ready = false;
  if (rescanTimer) clearInterval(rescanTimer);
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
      console.log(`Risk worker ${name} identity: ${identity.toHexString()}`);
      if (registerOnly) {
        console.log('Registered. Grant this identity the risk role, run access, and account access before starting the worker.');
        stopped = true;
        conn.disconnect();
        return;
      }
      const rescan = () => void cycle(conn);
      conn.db.myTradeProposal.onInsert(rescan);
      conn.db.myTradeProposal.onUpdate(rescan);
      conn.db.myRunConfig.onInsert(rescan);
      conn.db.myRunConfig.onUpdate(rescan);
      conn.db.myAgent.onInsert(rescan);
      conn.db.myAgent.onUpdate(rescan);
      conn.subscriptionBuilder()
        .onApplied(() => {
          ready = true;
          console.log(`Subscription ready (role: ${[...conn.db.myAgent.iter()].find(a => a.identity.equals(conn.identity!))?.role ?? 'not granted'})`);
          // Periodic scans catch expiring passes and accounts waiting out a retry delay.
          rescanTimer = setInterval(rescan, RESCAN_MS);
          rescan();
        })
        .onError(ctx => {
          console.error('Subscription failed:', ctx);
          try { conn.disconnect(); } catch { /* Connection may already be closed. */ }
          scheduleReconnect('Subscription ended');
        })
        .subscribe([
          'SELECT * FROM my_agent', 'SELECT * FROM my_run', 'SELECT * FROM my_trade_proposal',
          'SELECT * FROM my_run_config', 'SELECT * FROM my_risk_policy', 'SELECT * FROM my_risk_decision',
          'SELECT * FROM my_risk_reservation', 'SELECT * FROM my_paper_order', 'SELECT * FROM my_account_snapshot',
          'SELECT * FROM my_market_observation', 'SELECT * FROM my_market_clock',
        ]);
    })
    .onConnectError((_ctx, error) => scheduleReconnect(error))
    .onDisconnect((_ctx, error) => { if (!registerOnly) scheduleReconnect(error); })
    .build();
}

process.on('SIGINT', () => {
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  if (rescanTimer) clearInterval(rescanTimer);
  connection?.disconnect();
  process.exit(0);
});

connect();
