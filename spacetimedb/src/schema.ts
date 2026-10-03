import { schema, table, t } from 'spacetimedb/server';

export const ownerConfig = table({ name: 'owner_config' }, {
  key: t.string().primaryKey(), owner: t.identity(),
});
export const agent = table({ public: true }, {
  identity: t.identity().primaryKey(), role: t.string(), status: t.string(), lastSeen: t.timestamp(),
});
export const run = table({ public: true }, {
  id: t.string().primaryKey(), goal: t.string(), status: t.string(), createdAt: t.timestamp(),
});
export const task = table({ public: true }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), symbol: t.string(),
  kind: t.string(), objective: t.string(), status: t.string(), assignee: t.option(t.identity()),
  leaseUntil: t.option(t.timestamp()), version: t.u64(), result: t.string(),
  createdAt: t.timestamp(), updatedAt: t.timestamp(),
});
export const taskLease = table({ name: 'task_lease' }, {
  id: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(), taskId: t.string(), version: t.u64(),
});
export const message = table({ public: true }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), taskId: t.string(),
  sender: t.identity(), kind: t.string(), body: t.string(), evidenceRef: t.string(), createdAt: t.timestamp(),
});
export const source = table({ public: true }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), symbol: t.string(),
  kind: t.string(), uri: t.string(), asOf: t.timestamp(), retrievedAt: t.timestamp(),
  checksum: t.string(), artifactRef: t.string(),
});
export const fact = table({ public: true }, {
  id: t.string().primaryKey(), sourceId: t.string(), symbol: t.string().index('btree'),
  metric: t.string(), value: t.string(), unit: t.string(), period: t.string(), quality: t.string(), createdAt: t.timestamp(),
});
export const thesis = table({ public: true }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), symbol: t.string(), author: t.identity(),
  bullCase: t.string(), bearCase: t.string(), assumptions: t.string(), invalidation: t.string(),
  evidenceRefs: t.string(), createdAt: t.timestamp(),
});
export const decision = table({ public: true }, {
  id: t.string().primaryKey(), thesisId: t.string().unique(), reviewer: t.identity(),
  outcome: t.string(), rationale: t.string(), createdAt: t.timestamp(),
});
export const tradeProposal = table({ public: true }, {
  id: t.string().primaryKey(), runId: t.string().index('btree'), thesisId: t.string(), symbol: t.string(),
  side: t.string(), quantity: t.string(), orderType: t.string(), limitPrice: t.string(),
  status: t.string(), proposedBy: t.identity(), createdAt: t.timestamp(),
});
export const riskDecision = table({ name: 'risk_decision' }, {
  id: t.string().primaryKey(), proposalId: t.string().unique(), reviewer: t.identity(),
  policyVersion: t.string(), outcome: t.string(), checks: t.string(),
  decidedAt: t.timestamp(), expiresAt: t.timestamp(),
});
export const approval = table({ name: 'approval' }, {
  proposalId: t.string().primaryKey(), approver: t.identity(),
  riskDecisionId: t.string(), approvedAt: t.timestamp(),
});
export const paperOrder = table({ name: 'paper_order' }, {
  id: t.string().primaryKey(), proposalId: t.string().unique(), clientOrderId: t.string().unique(),
  alpacaOrderId: t.string(), status: t.string(), submittedAt: t.timestamp(), updatedAt: t.timestamp(),
});
export const fill = table({ name: 'fill' }, {
  id: t.string().primaryKey(), orderId: t.string(), alpacaActivityId: t.string().unique(),
  quantity: t.string(), price: t.string(), filledAt: t.timestamp(),
});
export const accountSnapshot = table({ name: 'account_snapshot' }, {
  id: t.string().primaryKey(), cash: t.string(), buyingPower: t.string(), equity: t.string(),
  positionsRef: t.string(), openOrdersRef: t.string(), capturedAt: t.timestamp(),
});
export const reconciliation = table({ name: 'reconciliation' }, {
  id: t.string().primaryKey(), status: t.string(), details: t.string(), capturedAt: t.timestamp(),
});
export const runMetric = table({ name: 'run_metric' }, {
  id: t.string().primaryKey(), runId: t.string(), name: t.string(), value: t.string(), observedAt: t.timestamp(),
});

const spacetimedb = schema({
  ownerConfig, agent, run, task, taskLease, message, source, fact, thesis,
  decision, tradeProposal, riskDecision, approval, paperOrder, fill, accountSnapshot,
  reconciliation, runMetric,
});
export default spacetimedb;
