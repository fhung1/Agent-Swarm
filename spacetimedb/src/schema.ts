import { schema, table, t } from 'spacetimedb/server';

export const ownerConfig = table({ name: 'owner_config' }, {
  key: t.string().primaryKey(), owner: t.identity(),
});
export const agent = table({ public: false }, {
  identity: t.identity().primaryKey(), role: t.string().index('btree'), status: t.string(), lastSeen: t.timestamp(),
});
export const run = table({ public: false }, {
  id: t.string().primaryKey(), goal: t.string(), status: t.string().index('btree'), createdAt: t.timestamp(),
});
export const task = table({ public: false }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), symbol: t.string(),
  kind: t.string(), objective: t.string(), status: t.string(), assignee: t.option(t.identity()),
  leaseUntil: t.option(t.timestamp()), version: t.u64(), result: t.string(),
  createdAt: t.timestamp(), updatedAt: t.timestamp(),
  role: t.string().default(''), dependsOn: t.string().default(''),
});
export const taskLease = table({ name: 'task_lease' }, {
  id: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(), taskId: t.string(), version: t.u64(),
});
export const message = table({ public: false }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), taskId: t.string(),
  sender: t.identity(), kind: t.string(), body: t.string(), evidenceRef: t.string(), createdAt: t.timestamp(),
  symbol: t.string().default(''), recipientRole: t.string().default(''),
});
export const source = table({ public: false }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), symbol: t.string(),
  kind: t.string(), uri: t.string(), asOf: t.timestamp(), retrievedAt: t.timestamp(),
  checksum: t.string(), artifactRef: t.string(),
});
export const fact = table({ public: false }, {
  id: t.string().primaryKey(), sourceId: t.string().index('btree'), symbol: t.string().index('btree'),
  metric: t.string(), value: t.string(), unit: t.string(), period: t.string(), quality: t.string(), createdAt: t.timestamp(),
});
export const thesis = table({ public: false }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), symbol: t.string(), author: t.identity(),
  bullCase: t.string(), bearCase: t.string(), assumptions: t.string(), invalidation: t.string(),
  evidenceRefs: t.string(), createdAt: t.timestamp(),
  taskId: t.string().default(''),
});
export const decision = table({ public: false }, {
  id: t.string().primaryKey(), thesisId: t.string().unique(), reviewer: t.identity(),
  outcome: t.string(), rationale: t.string(), createdAt: t.timestamp(),
});
export const tradeProposal = table({ public: false }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), thesisId: t.string(), symbol: t.string(),
  side: t.string(), quantity: t.string(), orderType: t.string(), limitPrice: t.string(),
  status: t.string(), proposedBy: t.identity(), createdAt: t.timestamp(),
});
export const riskDecision = table({ name: 'risk_decision' }, {
  id: t.string().primaryKey(), proposalId: t.string().unique(), reviewer: t.identity(),
  policyVersion: t.string(), outcome: t.string(), checks: t.string(),
  decidedAt: t.timestamp(), expiresAt: t.timestamp(),
  policyId: t.string().default(''), snapshotId: t.string().default(''), quoteId: t.string().default(''),
});
export const approval = table({ name: 'approval' }, {
  proposalId: t.string().primaryKey(), approver: t.identity(),
  riskDecisionId: t.string(), approvedAt: t.timestamp(),
});
export const riskDecisionHistory = table({ name: 'risk_decision_history' }, {
  id: t.string().primaryKey(), proposalId: t.string().index('btree'), reviewer: t.identity(),
  policyVersion: t.string(), outcome: t.string(), checks: t.string(), decidedAt: t.timestamp(), expiresAt: t.timestamp(),
  policyId: t.string(), snapshotId: t.string(), quoteId: t.string(),
});
export const paperOrder = table({ name: 'paper_order' }, {
  id: t.string().primaryKey(), proposalId: t.string().unique(), clientOrderId: t.string().unique(),
  alpacaOrderId: t.string(), status: t.string(), submittedAt: t.timestamp(), updatedAt: t.timestamp(),
});
export const orderCancelRequest = table({ name: 'order_cancel_request' }, {
  orderId: t.string().primaryKey(), requestedBy: t.identity(), reason: t.string(), status: t.string(),
  detail: t.string(), requestedAt: t.timestamp(), updatedAt: t.timestamp(),
});
export const paperSubmission = table({ name: 'paper_submission' }, {
  id: t.string().primaryKey(), orderId: t.string().index('btree'), actor: t.identity(),
  attempt: t.u32(), status: t.string(), details: t.string(), startedAt: t.timestamp(), updatedAt: t.timestamp(),
});
export const accountLedger = table({ name: 'account_ledger' }, {
  accountId: t.string().primaryKey(), cash: t.string(), positionsJson: t.string(), createdAt: t.timestamp(),
});
export const accountCheck = table({ name: 'account_check' }, {
  accountId: t.string().primaryKey(), status: t.string(), details: t.string(), checkedAt: t.timestamp(),
});
export const tradeUpdate = table({ name: 'trade_update' }, {
  id: t.string().primaryKey(), orderId: t.string().index('btree'), alpacaOrderId: t.string(),
  event: t.string(), brokerStatus: t.string(), executionId: t.string(), brokerTimestamp: t.timestamp(),
  receivedAt: t.timestamp(),
});
export const fill = table({ name: 'fill' }, {
  id: t.string().primaryKey(), orderId: t.string().index('btree'), alpacaActivityId: t.string().unique(),
  quantity: t.string(), price: t.string(), filledAt: t.timestamp(),
});
export const accountSnapshot = table({ name: 'account_snapshot' }, {
  id: t.string().primaryKey(), accountId: t.string().index('btree'), accountStatus: t.string(),
  cash: t.string(), buyingPower: t.string(), equity: t.string(),
  positionsJson: t.string(), openOrdersJson: t.string(), capturedAt: t.timestamp(),
});
export const marketObservation = table({ name: 'market_observation', public: false }, {
  id: t.string().primaryKey(), snapshotId: t.string().index('btree'), symbol: t.string().index('btree'),
  feed: t.string(), bidPrice: t.string(), bidSize: t.string(), askPrice: t.string(), askSize: t.string(),
  asOf: t.timestamp(), capturedAt: t.timestamp(),
});
export const reconciliation = table({ name: 'reconciliation' }, {
  id: t.string().primaryKey(), status: t.string(), details: t.string(), capturedAt: t.timestamp(),
  accountId: t.string().index('btree').default(''),
});
export const runMetric = table({ name: 'run_metric' }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), name: t.string(), value: t.string(), observedAt: t.timestamp(),
});

export const runAccess = table({ name: 'run_access' }, {
  id: t.string().primaryKey(), identity: t.identity().index('btree'), runId: t.string().index('btree'),
});
export const accountAccess = table({ name: 'account_access' }, {
  id: t.string().primaryKey(), identity: t.identity().index('btree'), accountId: t.string(),
});
export const riskPolicy = table({ name: 'risk_policy' }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), accountId: t.string(), policyJson: t.string(),
  createdAt: t.timestamp(),
});
export const runConfig = table({ name: 'run_config' }, {
  runId: t.string().primaryKey(), policyId: t.string(), maxInferences: t.u32(), maxTokens: t.u32(),
  maxConcurrent: t.u32(), maxAttempts: t.u32(), usedInferences: t.u32(), usedTokens: t.u32(),
  pricingVersion: t.string().default(''), maxSpendMicros: t.u64().default(0n),
  maxWorkerSpendMicros: t.u64().default(0n), usedSpendMicros: t.u64().default(0n),
});
export const marketClock = table({ name: 'market_clock' }, {
  accountId: t.string().primaryKey(), isOpen: t.bool(), asOf: t.timestamp(), capturedAt: t.timestamp(),
});
export const riskReservation = table({ name: 'risk_reservation' }, {
  proposalId: t.string().primaryKey(), accountId: t.string().index('btree'), quantity: t.string(),
  notional: t.string(), clientOrderId: t.string(),
});
export const decisionInput = table({ name: 'decision_input' }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), thesisId: t.string(), quoteId: t.string(),
  critiqueRefs: t.string(), model: t.string(), promptVersion: t.string(), policyVersion: t.string(),
  maxOrderNotional: t.string(), capturedAt: t.timestamp(),
});
export const inferenceAttempt = table({ name: 'inference_attempt' }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), workId: t.string().index('btree'), actor: t.identity(),
  model: t.string(), promptVersion: t.string(), inputRefs: t.string(), status: t.string(),
  reservedTokens: t.u32(), tokensUsed: t.u32(), startedAt: t.timestamp(), expiresAt: t.timestamp(),
  actualModel: t.string().default(''), outputJson: t.string().default(''),
  pricingVersion: t.string().default(''), reservedInputTokens: t.u32().default(0), reservedOutputTokens: t.u32().default(0),
  inputTokens: t.u32().default(0), cacheReadTokens: t.u32().default(0), cacheWriteTokens: t.u32().default(0), outputTokens: t.u32().default(0),
  reservedSpendMicros: t.u64().default(0n), spendMicros: t.u64().default(0n),
  failureReason: t.string().default(''),
});
export const modelPrice = table({ name: 'model_price' }, {
  id: t.string().primaryKey(), version: t.string().index('btree'), model: t.string(),
  inputMicrosPerMillion: t.u64(), cacheReadMicrosPerMillion: t.u64(), cacheWriteMicrosPerMillion: t.u64(),
  outputMicrosPerMillion: t.u64(), createdAt: t.timestamp(),
});

const spacetimedb = schema({
  ownerConfig, agent, run, task, taskLease, message, source, fact, thesis,
  decision, tradeProposal, riskDecision, approval, paperOrder, orderCancelRequest, tradeUpdate, fill, accountSnapshot,
  marketObservation, reconciliation, runMetric, runAccess, accountAccess, riskPolicy, runConfig, marketClock,
  riskReservation, decisionInput, inferenceAttempt, modelPrice, riskDecisionHistory, paperSubmission, accountLedger, accountCheck,
});
export default spacetimedb;
