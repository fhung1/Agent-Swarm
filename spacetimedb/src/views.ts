import { t, type ViewCtx, type InferSchema } from 'spacetimedb/server';
import spacetimedb, { agent, run, task, message, source, fact, thesis, decision, tradeProposal,
  marketObservation, accountSnapshot, riskDecision, approval, paperOrder, orderCancelRequest, tradeUpdate, fill, reconciliation,
  runMetric, runConfig, riskPolicy, marketClock, riskReservation, decisionInput, inferenceAttempt, riskDecisionHistory,
  paperSubmission, accountLedger, accountCheck } from './schema';
import { ROLES } from './access';

type Context = ViewCtx<InferSchema<typeof spacetimedb>>;
function role(ctx: Context): string | undefined {
  const value = ctx.db.agent.identity.find(ctx.sender)?.role;
  return ROLES.includes(value as typeof ROLES[number]) ? value : undefined;
}
function runs(ctx: Context): string[] {
  if (!role(ctx)) return [];
  if (role(ctx) === 'operator') return ['active', 'paused', 'closed'].flatMap(status =>
    [...ctx.db.run.status.filter(status)].map(row => row.id));
  return [...ctx.db.runAccess.identity.filter(ctx.sender)].map(row => row.runId);
}
function accounts(ctx: Context): string[] {
  if (!['operator', 'risk', 'executor', 'market_data', 'portfolio', 'coordinator'].includes(role(ctx) ?? '')) return [];
  return [...ctx.db.accountAccess.identity.filter(ctx.sender)].map(row => row.accountId);
}
function sources(ctx: Context) { return runs(ctx).flatMap(id => [...ctx.db.source.runId.filter(id)]); }
function theses(ctx: Context) { return runs(ctx).flatMap(id => [...ctx.db.thesis.runId.filter(id)]); }
function proposals(ctx: Context) { return runs(ctx).flatMap(id => [...ctx.db.tradeProposal.runId.filter(id)]); }
function orders(ctx: Context) {
  if (!['operator', 'risk', 'executor', 'coordinator'].includes(role(ctx) ?? '')) return [];
  const allowed = new Set(accounts(ctx));
  return proposals(ctx).flatMap(p => {
    const reservation = ctx.db.riskReservation.proposalId.find(p.id);
    const order = ctx.db.paperOrder.proposalId.find(p.id);
    return reservation && allowed.has(reservation.accountId) && order ? [order] : [];
  });
}

export const myAgent = spacetimedb.view({ name: 'my_agent', public: true }, t.array(agent.rowType), ctx => {
  const row = ctx.db.agent.identity.find(ctx.sender);
  return row && role(ctx) ? [row] : [];
});
// The operator needs the authenticated sender's current role to label the audit timeline.
// Keep other workers limited to their own my_agent row.
export const myAgentDirectory = spacetimedb.view({ name: 'my_agent_directory', public: true }, t.array(agent.rowType), ctx =>
  role(ctx) === 'operator' ? [...ROLES, 'revoked'].flatMap(granted => [...ctx.db.agent.role.filter(granted)]) : []);
export const myRun = spacetimedb.view({ name: 'my_run', public: true }, t.array(run.rowType), ctx =>
  runs(ctx).flatMap(id => { const row = ctx.db.run.id.find(id); return row ? [row] : []; }));
export const myTask = spacetimedb.view({ name: 'my_task', public: true }, t.array(task.rowType), ctx =>
  runs(ctx).flatMap(id => [...ctx.db.task.runId.filter(id)]));
// Team messages remain shared inside an authorized run. recipientRole is routing, not an ACL.
export const myMessage = spacetimedb.view({ name: 'my_message', public: true }, t.array(message.rowType), ctx =>
  runs(ctx).flatMap(id => [...ctx.db.message.runId.filter(id)]));
export const mySource = spacetimedb.view({ name: 'my_source', public: true }, t.array(source.rowType), sources);
export const myFact = spacetimedb.view({ name: 'my_fact', public: true }, t.array(fact.rowType), ctx =>
  sources(ctx).flatMap(row => [...ctx.db.fact.sourceId.filter(row.id)]));
export const myThesis = spacetimedb.view({ name: 'my_thesis', public: true }, t.array(thesis.rowType), theses);
export const myDecision = spacetimedb.view({ name: 'my_decision', public: true }, t.array(decision.rowType), ctx =>
  theses(ctx).flatMap(row => { const result = ctx.db.decision.thesisId.find(row.id); return result ? [result] : []; }));
export const myTradeProposal = spacetimedb.view({ name: 'my_trade_proposal', public: true }, t.array(tradeProposal.rowType), proposals);
export const myMarketObservation = spacetimedb.view({ name: 'my_market_observation', public: true }, t.array(marketObservation.rowType), ctx => {
  const symbols = new Set(runs(ctx).flatMap(id => [...ctx.db.task.runId.filter(id)].map(row => row.symbol)));
  const output = new Map<string, typeof marketObservation.rowType.type>();
  for (const symbol of symbols) for (const row of ctx.db.marketObservation.symbol.filter(symbol)) output.set(row.id, row);
  for (const account of accounts(ctx)) for (const snapshot of ctx.db.accountSnapshot.accountId.filter(account)) {
    for (const row of ctx.db.marketObservation.snapshotId.filter(snapshot.id)) output.set(row.id, row);
  }
  return [...output.values()];
});
export const myAccountSnapshot = spacetimedb.view({ name: 'my_account_snapshot', public: true }, t.array(accountSnapshot.rowType), ctx =>
  accounts(ctx).flatMap(id => [...ctx.db.accountSnapshot.accountId.filter(id)]));
export const myRiskDecision = spacetimedb.view({ name: 'my_risk_decision', public: true }, t.array(riskDecision.rowType), ctx =>
  ['operator', 'risk', 'executor'].includes(role(ctx) ?? '') ? proposals(ctx).flatMap(p => {
    const row = ctx.db.riskDecision.proposalId.find(p.id);
    return row && accounts(ctx).includes(ctx.db.riskPolicy.id.find(row.policyId)?.accountId ?? '') ? [row] : [];
  }) : []);
export const myApproval = spacetimedb.view({ name: 'my_approval', public: true }, t.array(approval.rowType), ctx =>
  ['operator', 'executor'].includes(role(ctx) ?? '') ? proposals(ctx).flatMap(p => {
    const row = ctx.db.approval.proposalId.find(p.id);
    const risk = ctx.db.riskDecision.proposalId.find(p.id);
    return row && risk && accounts(ctx).includes(ctx.db.riskPolicy.id.find(risk.policyId)?.accountId ?? '') ? [row] : [];
  }) : []);
export const myRiskDecisionHistory = spacetimedb.view({ name: 'my_risk_decision_history', public: true }, t.array(riskDecisionHistory.rowType), ctx =>
  ['operator', 'risk', 'executor'].includes(role(ctx) ?? '') ? proposals(ctx).flatMap(p =>
    [...ctx.db.riskDecisionHistory.proposalId.filter(p.id)].filter(row => accounts(ctx).includes(ctx.db.riskPolicy.id.find(row.policyId)?.accountId ?? ''))) : []);
export const myPaperOrder = spacetimedb.view({ name: 'my_paper_order', public: true }, t.array(paperOrder.rowType), orders);
export const myOrderCancelRequest = spacetimedb.view({ name: 'my_order_cancel_request', public: true }, t.array(orderCancelRequest.rowType), ctx =>
  ['operator', 'executor'].includes(role(ctx) ?? '') ? orders(ctx).flatMap(order => {
    const row = ctx.db.orderCancelRequest.orderId.find(order.id); return row ? [row] : [];
  }) : []);
export const myTradeUpdate = spacetimedb.view({ name: 'my_trade_update', public: true }, t.array(tradeUpdate.rowType), ctx =>
  ['operator', 'executor'].includes(role(ctx) ?? '') ? orders(ctx).flatMap(order => [...ctx.db.tradeUpdate.orderId.filter(order.id)]) : []);
export const myFill = spacetimedb.view({ name: 'my_fill', public: true }, t.array(fill.rowType), ctx =>
  orders(ctx).flatMap(order => [...ctx.db.fill.orderId.filter(order.id)]));
export const myPaperSubmission = spacetimedb.view({name:'my_paper_submission',public:true},t.array(paperSubmission.rowType),ctx=>
  orders(ctx).flatMap(order=>[...ctx.db.paperSubmission.orderId.filter(order.id)]));
export const myAccountLedger = spacetimedb.view({name:'my_account_ledger',public:true},t.array(accountLedger.rowType),ctx=>
  accounts(ctx).flatMap(id=>{const row=ctx.db.accountLedger.accountId.find(id);return row?[row]:[];}));
export const myAccountCheck = spacetimedb.view({name:'my_account_check',public:true},t.array(accountCheck.rowType),ctx=>
  accounts(ctx).flatMap(id=>{const row=ctx.db.accountCheck.accountId.find(id);return row?[row]:[];}));
export const myRunMetric = spacetimedb.view({ name: 'my_run_metric', public: true }, t.array(runMetric.rowType), ctx =>
  ['operator', 'coordinator', 'risk'].includes(role(ctx) ?? '') ? runs(ctx).flatMap(id => [...ctx.db.runMetric.runId.filter(id)]) : []);
export const myRunConfig = spacetimedb.view({ name: 'my_run_config', public: true }, t.array(runConfig.rowType), ctx =>
  runs(ctx).flatMap(id => { const row = ctx.db.runConfig.runId.find(id); return row ? [row] : []; }));
export const myRiskPolicy = spacetimedb.view({ name: 'my_risk_policy', public: true }, t.array(riskPolicy.rowType), ctx =>
  ['operator', 'risk', 'executor', 'coordinator', 'portfolio'].includes(role(ctx) ?? '') ? runs(ctx).flatMap(id =>
    [...ctx.db.riskPolicy.runId.filter(id)].filter(policy => role(ctx) !== 'portfolio' || accounts(ctx).includes(policy.accountId))) : []);
export const myMarketClock = spacetimedb.view({ name: 'my_market_clock', public: true }, t.array(marketClock.rowType), ctx =>
  accounts(ctx).flatMap(id => { const row = ctx.db.marketClock.accountId.find(id); return row ? [row] : []; }));
export const myRiskReservation = spacetimedb.view({ name: 'my_risk_reservation', public: true }, t.array(riskReservation.rowType), ctx =>
  ['operator', 'risk', 'executor'].includes(role(ctx) ?? '') ? accounts(ctx).flatMap(id => [...ctx.db.riskReservation.accountId.filter(id)]) : []);
export const myDecisionInput = spacetimedb.view({ name: 'my_decision_input', public: true }, t.array(decisionInput.rowType), ctx =>
  runs(ctx).flatMap(id => [...ctx.db.decisionInput.runId.filter(id)]));
export const myInferenceAttempt = spacetimedb.view({ name: 'my_inference_attempt', public: true }, t.array(inferenceAttempt.rowType), ctx =>
  runs(ctx).flatMap(id => [...ctx.db.inferenceAttempt.runId.filter(id)]));
// Reconciliations are operator/executor-only and indexed by their recording identity's authorized account.
export const myReconciliation = spacetimedb.view({ name: 'my_reconciliation', public: true }, t.array(reconciliation.rowType), ctx =>
  ['operator', 'executor'].includes(role(ctx) ?? '') ? accounts(ctx).flatMap(id => [...ctx.db.reconciliation.accountId.filter(id)]) : []);
