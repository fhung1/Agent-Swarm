import { Timestamp } from 'spacetimedb';
import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from './schema';
import { decimal, validOrderTransition } from './domain';
import { evaluateProposal, requireCurrentRisk } from './risk-gate';
import { parsePositions, parseOpenOrders } from './risk';
import { parseRefs, requireAccountAccess, requireEvidence, requireId, requireRole, requireRun, requireRunAccess, requireSymbol, requireText, type Ctx } from './access';

const marketObservationInput = t.object('MarketObservationInput', {
  id: t.string(), symbol: t.string(), feed: t.string(), bidPrice: t.string(), bidSize: t.string(),
  askPrice: t.string(), askSize: t.string(), asOf: t.timestamp(),
});

export const addSource = spacetimedb.reducer(
  { id: t.string(), runId: t.string(), symbol: t.string(), kind: t.string(), uri: t.string(),
    asOf: t.timestamp(), checksum: t.string(), artifactRef: t.string() },
  (ctx, value) => {
    requireRole(ctx, ['ingestor']); requireRun(ctx, value.runId); requireId(value.id);
    requireSymbol(value.symbol); requireText(value.kind, 'Source kind', 64);
    if (value.asOf.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('Future-dated source');
    if (value.artifactRef.length > 2048) throw new SenderError('Artifact reference too long');
    requireText(value.uri, 'URI', 2048); requireText(value.checksum, 'Checksum', 128);
    if (ctx.db.source.id.find(value.id)) throw new SenderError('Source already exists');
    ctx.db.source.insert({ ...value, retrievedAt: ctx.timestamp });
  }
);

export const addFact = spacetimedb.reducer(
  { id: t.string(), sourceId: t.string(), symbol: t.string(), metric: t.string(), value: t.string(),
    unit: t.string(), period: t.string(), quality: t.string() },
  (ctx, value) => {
    requireRole(ctx, ['ingestor']); requireId(value.id);
    const linkedSource = ctx.db.source.id.find(value.sourceId);
    if (!linkedSource || linkedSource.symbol !== value.symbol) throw new SenderError('Source mismatch');
    requireRun(ctx, linkedSource.runId); requireSymbol(value.symbol);
    for (const [name, field] of [['Metric', value.metric], ['Value', value.value], ['Unit', value.unit], ['Period', value.period], ['Quality', value.quality]]) requireText(field, name, 256);
    if (ctx.db.fact.id.find(value.id)) throw new SenderError('Fact already exists');
    ctx.db.fact.insert({ ...value, createdAt: ctx.timestamp });
  }
);

export const publishThesis = spacetimedb.reducer(
  { id: t.string(), runId: t.string(), taskId: t.string(), symbol: t.string(), bullCase: t.string(), bearCase: t.string(),
    assumptions: t.string(), invalidation: t.string(), evidenceRefs: t.string() },
  (ctx, value) => {
    requireRole(ctx, ['analyst', 'skeptic', 'coordinator']); requireRun(ctx, value.runId); requireId(value.id);
    requireSymbol(value.symbol);
    requireText(value.bullCase, 'Bull case'); requireText(value.bearCase, 'Bear case');
    requireText(value.invalidation, 'Invalidation'); requireText(value.assumptions, 'Assumptions');
    // A thesis must cite at least one stored, same-symbol research or market observation.
    const refs = parseRefs(value.evidenceRefs);
    if (refs.length === 0) throw new SenderError('Thesis needs at least one evidence reference');
    requireEvidence(ctx, refs, value.symbol, ['source', 'fact', 'market_observation'], value.runId);
    if (value.taskId) {
      const linkedTask = ctx.db.task.id.find(value.taskId);
      if (!linkedTask || linkedTask.runId !== value.runId || linkedTask.symbol !== value.symbol) throw new SenderError('Task mismatch');
      if (linkedTask.status !== 'claimed' || !linkedTask.assignee?.equals(ctx.sender)) throw new SenderError('Task not owned');
      if (!linkedTask.leaseUntil || linkedTask.leaseUntil.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('Lease expired');
    }
    const existing = ctx.db.thesis.id.find(value.id);
    if (existing) {
      if (existing.author.equals(ctx.sender) && existing.runId === value.runId && existing.taskId === value.taskId &&
          existing.symbol === value.symbol && existing.bullCase === value.bullCase && existing.bearCase === value.bearCase &&
          existing.assumptions === value.assumptions && existing.invalidation === value.invalidation &&
          existing.evidenceRefs === value.evidenceRefs) return;
      throw new SenderError('Thesis already exists');
    }
    ctx.db.thesis.insert({ ...value, author: ctx.sender, createdAt: ctx.timestamp });
  }
);

type DecisionArgs = { id: string; thesisId: string; outcome: string; rationale: string };
type ProposalArgs = { id: string; runId: string; thesisId: string; symbol: string; side: string;
  quantity: string; orderType: string; limitPrice: string };

function writeDecision(ctx: Ctx, value: DecisionArgs): void {
  requireRole(ctx, ['coordinator', 'operator']); requireId(value.id);
  if (!['trade', 'abstain', 'revise'].includes(value.outcome)) throw new SenderError('Invalid outcome');
  const linkedThesis = ctx.db.thesis.id.find(value.thesisId);
  if (!linkedThesis) throw new SenderError('Thesis not found');
  requireRun(ctx, linkedThesis.runId); requireText(value.rationale, 'Rationale');
  const existing = ctx.db.decision.thesisId.find(value.thesisId);
  if (existing) {
    if (existing.id === value.id && existing.reviewer.equals(ctx.sender) && existing.outcome === value.outcome &&
        existing.rationale === value.rationale) return;
    throw new SenderError('Thesis already decided');
  }
  ctx.db.decision.insert({ ...value, reviewer: ctx.sender, createdAt: ctx.timestamp });
}

function writeProposal(ctx: Ctx, value: ProposalArgs): void {
  requireRole(ctx, ['coordinator']); requireRun(ctx, value.runId); requireId(value.id);
  const linkedThesis = ctx.db.thesis.id.find(value.thesisId);
  if (!linkedThesis || linkedThesis.runId !== value.runId || linkedThesis.symbol !== value.symbol) throw new SenderError('Thesis mismatch');
  if (ctx.db.decision.thesisId.find(value.thesisId)?.outcome !== 'trade') throw new SenderError('Trade decision required');
  if (!['buy', 'sell'].includes(value.side) || !['market', 'limit'].includes(value.orderType)) throw new SenderError('Invalid order parameters');
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value.quantity) || Number(value.quantity) <= 0) throw new SenderError('Invalid quantity');
  decimal(value.quantity, 6, true);
  if (value.orderType === 'limit' && (!/^(0|[1-9]\d*)(\.\d{1,4})?$/.test(value.limitPrice) || Number(value.limitPrice) <= 0)) throw new SenderError('Invalid limit price');
  if (value.orderType === 'limit') decimal(value.limitPrice, 4, true);
  if (value.orderType === 'market' && value.limitPrice !== '') throw new SenderError('Market order cannot have limit price');
  const existing = ctx.db.tradeProposal.id.find(value.id);
  if (existing) {
    if (existing.proposedBy.equals(ctx.sender) && existing.runId === value.runId &&
        existing.thesisId === value.thesisId && existing.symbol === value.symbol &&
        existing.side === value.side && existing.quantity === value.quantity &&
        existing.orderType === value.orderType && existing.limitPrice === value.limitPrice) return;
    throw new SenderError('Proposal ID already used');
  }
  ctx.db.tradeProposal.insert({ ...value, status: 'proposed', proposedBy: ctx.sender, createdAt: ctx.timestamp });
}

export const recordDecision = spacetimedb.reducer(
  { id: t.string(), thesisId: t.string(), outcome: t.string(), rationale: t.string() },
  writeDecision,
);

export const proposeTrade = spacetimedb.reducer(
  { id: t.string(), runId: t.string(), thesisId: t.string(), symbol: t.string(), side: t.string(),
    quantity: t.string(), orderType: t.string(), limitPrice: t.string() },
  writeProposal,
);

// A trade decision and its proposal commit together, including identical retries after a disconnect.
export const recordTradeDecision = spacetimedb.reducer(
  { decisionId: t.string(), rationale: t.string(), proposalId: t.string(), runId: t.string(),
    thesisId: t.string(), symbol: t.string(), side: t.string(), quantity: t.string(),
    orderType: t.string(), limitPrice: t.string() },
  (ctx, { decisionId, rationale, proposalId, ...proposal }) => {
    requireRole(ctx, ['coordinator']);
    writeDecision(ctx, { id: decisionId, thesisId: proposal.thesisId, outcome: 'trade', rationale });
    writeProposal(ctx, { id: proposalId, ...proposal });
  },
);

export const recordRiskDecision = spacetimedb.reducer(
  { id: t.string(), proposalId: t.string(), policyVersion: t.string(), outcome: t.string(),
    checks: t.string(), expiresAt: t.timestamp(), snapshotId: t.string(), clockAsOf: t.timestamp() },
  (ctx, value) => {
    requireRole(ctx, ['risk']); requireId(value.id);
    const proposal = ctx.db.tradeProposal.id.find(value.proposalId);
    const intent=ctx.db.paperOrder.proposalId.find(value.proposalId);
    const unsubmitted=!!intent&&!intent.alpacaOrderId&&intent.status==='submitting';
    if (!proposal || !['proposed', 'risk_passed', 'approved',...(unsubmitted?['submitting']:[])].includes(proposal.status) || (intent&&!unsubmitted)) throw new SenderError('Proposal is not awaiting risk review');
    requireRun(ctx, proposal.runId);
    if (!['pass', 'reject'].includes(value.outcome)) throw new SenderError('Invalid risk outcome');
    const computed = evaluateProposal(ctx, value.proposalId);
    const clock = ctx.db.marketClock.accountId.find(computed.policyRow.accountId);
    if (value.snapshotId !== computed.snapshot.id || !clock || value.clockAsOf.microsSinceUnixEpoch !== clock.asOf.microsSinceUnixEpoch) throw new SenderError('Risk inputs changed; retry from fresh snapshot');
    if (!ctx.db.accountAccess.id.find(`${ctx.sender.toHexString()}:${computed.policyRow.accountId}`)) throw new SenderError('Account access required');
    if (value.policyVersion !== computed.policyRow.id || value.outcome !== computed.result.outcome) throw new SenderError('Risk verdict must match authoritative evaluation');
    const expiresAt = value.expiresAt.microsSinceUnixEpoch < BigInt(computed.result.expiresAt.getTime()) * 1000n
      ? value.expiresAt : new Timestamp(BigInt(computed.result.expiresAt.getTime()) * 1000n);
    if (expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('Risk decision already expired');
    const existing = ctx.db.riskDecision.proposalId.find(value.proposalId);
    const priorReservation=ctx.db.riskReservation.proposalId.find(proposal.id);
    if (ctx.db.riskDecision.id.find(value.id) || ctx.db.riskDecisionHistory.id.find(value.id)) throw new SenderError('Risk decision ID already used');
    if (existing) {
      ctx.db.riskDecisionHistory.insert(existing);
      ctx.db.riskDecision.id.delete(existing.id);
      ctx.db.approval.proposalId.delete(proposal.id);
      if(!intent)ctx.db.riskReservation.proposalId.delete(proposal.id);
    }
    const { clockAsOf: _clockAsOf, ...record } = value;
    ctx.db.riskDecision.insert({ ...record, checks: JSON.stringify(computed.result.checks), expiresAt,
      policyId: computed.policyRow.id, snapshotId: computed.snapshot.id, quoteId: computed.quote.id,
      reviewer: ctx.sender, decidedAt: ctx.timestamp });
    if(intent){
      if(!priorReservation||priorReservation.accountId!==computed.policyRow.accountId)throw new SenderError('Cannot move a submitted reservation between accounts');
      if(value.outcome==='pass')ctx.db.riskReservation.proposalId.update({...priorReservation,notional:computed.notional});
    }else if (value.outcome === 'pass') ctx.db.riskReservation.insert({ proposalId: proposal.id, accountId: computed.policyRow.accountId,
      quantity: proposal.quantity, notional: computed.notional, clientOrderId: '' });
    ctx.db.tradeProposal.id.update({ ...proposal, status: intent?'submitting':value.outcome === 'pass' ? 'risk_passed' : 'rejected' });
  }
);

export const approveProposal = spacetimedb.reducer({ proposalId: t.string() }, (ctx, { proposalId }) => {
  requireRole(ctx, ['operator']);
  const proposal = ctx.db.tradeProposal.id.find(proposalId);
  if (!proposal || proposal.status !== 'risk_passed') throw new SenderError('Proposal is not risk passed');
  requireRun(ctx, proposal.runId);
  const risk = ctx.db.riskDecision.proposalId.find(proposalId);
  requireCurrentRisk(ctx, proposalId);
  if (ctx.db.approval.proposalId.find(proposalId)) throw new SenderError('Already approved');
  ctx.db.approval.insert({ proposalId, approver: ctx.sender, riskDecisionId: risk!.id, approvedAt: ctx.timestamp });
  ctx.db.tradeProposal.id.update({ ...proposal, status: 'approved' });
});

export const reservePaperOrder = spacetimedb.reducer(
  { id: t.string(), proposalId: t.string(), clientOrderId: t.string() },
  (ctx, value) => {
    requireRole(ctx, ['executor']); requireId(value.id); requireText(value.clientOrderId, 'Client order ID', 128);
    const proposal = ctx.db.tradeProposal.id.find(value.proposalId);
    if (!proposal) throw new SenderError('Proposal not found');
    requireRunAccess(ctx, proposal.runId);
    const reservation = ctx.db.riskReservation.proposalId.find(value.proposalId);
    if (!reservation || !ctx.db.accountAccess.id.find(`${ctx.sender.toHexString()}:${reservation.accountId}`)) throw new SenderError('Account access required');
    const prior = ctx.db.paperOrder.id.find(value.id);
    if (prior) {
      if (prior.proposalId === value.proposalId && prior.clientOrderId === value.clientOrderId) return;
      throw new SenderError('Order ID already used');
    }
    if (!proposal || !['risk_passed', 'approved'].includes(proposal.status)) throw new SenderError('Proposal is not risk passed');
    requireRun(ctx, proposal.runId);
    requireCurrentRisk(ctx, value.proposalId);
    if (ctx.db.paperOrder.proposalId.find(value.proposalId) || ctx.db.paperOrder.clientOrderId.find(value.clientOrderId)) throw new SenderError('Order intent already reserved');
    ctx.db.riskReservation.proposalId.update({ ...reservation, clientOrderId: value.clientOrderId });
    ctx.db.paperOrder.insert({ ...value, alpacaOrderId: '', status: 'submitting', submittedAt: ctx.timestamp, updatedAt: ctx.timestamp });
    ctx.db.tradeProposal.id.update({ ...proposal, status: 'submitting' });
  }
);

export const updatePaperOrder = spacetimedb.reducer(
  { id: t.string(), alpacaOrderId: t.string(), status: t.string() },
  (ctx, { id, alpacaOrderId, status }) => {
    requireRole(ctx, ['executor']);
    const existing = ctx.db.paperOrder.id.find(id);
    if (!existing) throw new SenderError('Order not found');
    const access = ctx.db.riskReservation.proposalId.find(existing.proposalId);
    if (!access || !ctx.db.accountAccess.id.find(`${ctx.sender.toHexString()}:${access.accountId}`)) throw new SenderError('Account access required');
    requireRunAccess(ctx, ctx.db.tradeProposal.id.find(existing.proposalId)!.runId);
    if (!validOrderTransition(existing.status, status)) throw new SenderError('Invalid order transition');
    // A broker refusal before it creates an order (for example, insufficient buying power) has no Alpaca order ID.
    const refusedBeforeCreation = status === 'rejected' && alpacaOrderId === '' && !existing.alpacaOrderId;
    if(refusedBeforeCreation&&[...ctx.db.paperSubmission.orderId.filter(id)].some(a=>!['refused','retry'].includes(a.status)))throw new SenderError('Uncertain submission cannot release exposure without operator reconciliation');
    if (!refusedBeforeCreation) requireText(alpacaOrderId, 'Alpaca order ID', 128);
    if (existing.alpacaOrderId && existing.alpacaOrderId !== alpacaOrderId) throw new SenderError('Alpaca order identity cannot change');
    const linked = ctx.db.tradeProposal.id.find(existing.proposalId)!;
    const total = [...ctx.db.fill.iter()].filter(fill => fill.orderId === id).reduce((sum, fill) => sum + decimal(fill.quantity, 6, true), 0n);
    if (status === 'filled' && total !== decimal(linked.quantity, 6, true)) throw new SenderError('Filled status requires reconciled fills');
    ctx.db.paperOrder.id.update({ ...existing, alpacaOrderId, status, updatedAt: ctx.timestamp });
  }
);

const TERMINAL_ORDER_STATUSES = ['filled', 'canceled', 'expired', 'rejected', 'replaced'];

export const requestOrderCancel = spacetimedb.reducer(
  { orderId: t.string(), reason: t.string() },
  (ctx, { orderId, reason }) => {
    requireRole(ctx, ['operator']); requireText(reason, 'Cancellation reason', 512);
    const order = ctx.db.paperOrder.id.find(orderId);
    if (!order) throw new SenderError('Order not found');
    const proposal = ctx.db.tradeProposal.id.find(order.proposalId);
    const reservation = ctx.db.riskReservation.proposalId.find(order.proposalId);
    if (!proposal || !reservation) throw new SenderError('Order linkage missing');
    requireRunAccess(ctx, proposal.runId); requireAccountAccess(ctx, reservation.accountId);
    if (TERMINAL_ORDER_STATUSES.includes(order.status)) throw new SenderError('Order is already terminal');
    if (!order.alpacaOrderId) throw new SenderError('Order has not been accepted by the broker');
    const existing = ctx.db.orderCancelRequest.orderId.find(orderId);
    if (existing) {
      if (existing.requestedBy.equals(ctx.sender) && existing.reason === reason) return;
      throw new SenderError('Cancellation already requested');
    }
    ctx.db.orderCancelRequest.insert({ orderId, requestedBy: ctx.sender, reason, status: 'requested', detail: '',
      requestedAt: ctx.timestamp, updatedAt: ctx.timestamp });
  },
);

export const updateOrderCancel = spacetimedb.reducer(
  { orderId: t.string(), status: t.string(), detail: t.string() },
  (ctx, { orderId, status, detail }) => {
    requireRole(ctx, ['executor']);
    if (!['broker_requested', 'resolved', 'refused'].includes(status)) throw new SenderError('Invalid cancellation status');
    if (detail.length > 1024) throw new SenderError('Cancellation detail too long');
    const request = ctx.db.orderCancelRequest.orderId.find(orderId);
    const order = ctx.db.paperOrder.id.find(orderId);
    if (!request || !order) throw new SenderError('Cancellation request not found');
    const proposal = ctx.db.tradeProposal.id.find(order.proposalId);
    const reservation = ctx.db.riskReservation.proposalId.find(order.proposalId);
    if (!proposal || !reservation) throw new SenderError('Order linkage missing');
    requireRunAccess(ctx, proposal.runId); requireAccountAccess(ctx, reservation.accountId);
    const allowed = request.status === 'requested'
      ? ['broker_requested', 'resolved', 'refused']
      : request.status === 'broker_requested' ? ['broker_requested', 'resolved', 'refused'] : [request.status];
    if (!allowed.includes(status)) throw new SenderError('Invalid cancellation transition');
    if (status === 'resolved' && !TERMINAL_ORDER_STATUSES.includes(order.status)) {
      throw new SenderError('Resolved cancellation requires a terminal order');
    }
    if (request.status === status && request.detail === detail) return;
    ctx.db.orderCancelRequest.orderId.update({ ...request, status, detail, updatedAt: ctx.timestamp });
  },
);

export const recordTradeUpdate = spacetimedb.reducer(
  { id: t.string(), orderId: t.string(), alpacaOrderId: t.string(), event: t.string(), brokerStatus: t.string(),
    executionId: t.string(), brokerTimestamp: t.timestamp() },
  (ctx, value) => {
    requireRole(ctx, ['executor']); requireId(value.id);
    const order = ctx.db.paperOrder.id.find(value.orderId);
    if (!order || !order.alpacaOrderId || order.alpacaOrderId !== value.alpacaOrderId) throw new SenderError('Broker order mismatch');
    const proposal = ctx.db.tradeProposal.id.find(order.proposalId);
    const reservation = ctx.db.riskReservation.proposalId.find(order.proposalId);
    if (!proposal || !reservation) throw new SenderError('Order linkage missing');
    requireRunAccess(ctx, proposal.runId); requireAccountAccess(ctx, reservation.accountId);
    if (!['new', 'fill', 'partial_fill', 'canceled', 'expired', 'done_for_day', 'replaced', 'rejected',
      'pending_new', 'pending_cancel', 'order_replace_rejected', 'order_cancel_rejected'].includes(value.event)) {
      throw new SenderError('Invalid trade update event');
    }
    requireText(value.brokerStatus, 'Broker status', 64);
    if (value.executionId.length > 128) throw new SenderError('Execution ID too long');
    const existing = ctx.db.tradeUpdate.id.find(value.id);
    if (existing) {
      if (existing.orderId === value.orderId && existing.alpacaOrderId === value.alpacaOrderId &&
          existing.event === value.event && existing.brokerStatus === value.brokerStatus &&
          existing.executionId === value.executionId &&
          existing.brokerTimestamp.microsSinceUnixEpoch === value.brokerTimestamp.microsSinceUnixEpoch) return;
      throw new SenderError('Trade update ID already used');
    }
    ctx.db.tradeUpdate.insert({ ...value, receivedAt: ctx.timestamp });
  },
);

export const recordFill = spacetimedb.reducer(
  { id: t.string(), orderId: t.string(), alpacaActivityId: t.string(), quantity: t.string(),
    price: t.string(), filledAt: t.timestamp() },
  (ctx, value) => {
    requireRole(ctx, ['executor']); requireId(value.id);
    const order = ctx.db.paperOrder.id.find(value.orderId);
    if (!order || !order.alpacaOrderId) throw new SenderError('Broker order identity required');
    const access = ctx.db.riskReservation.proposalId.find(order.proposalId);
    if (!access || !ctx.db.accountAccess.id.find(`${ctx.sender.toHexString()}:${access.accountId}`)) throw new SenderError('Account access required');
    requireRunAccess(ctx, ctx.db.tradeProposal.id.find(order.proposalId)!.runId);
    requireText(value.alpacaActivityId, 'Alpaca activity ID', 128);
    const quantity = decimal(value.quantity, 6, true); decimal(value.price, 12, true);
    if (value.filledAt.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch ||
        value.filledAt.microsSinceUnixEpoch < order.submittedAt.microsSinceUnixEpoch) throw new SenderError('Invalid fill time');
    const existing = ctx.db.fill.alpacaActivityId.find(value.alpacaActivityId);
    if (existing) {
      if (existing.id === value.id && existing.orderId === value.orderId && existing.quantity === value.quantity && existing.price === value.price && existing.filledAt.microsSinceUnixEpoch === value.filledAt.microsSinceUnixEpoch) return;
      throw new SenderError('Activity ID already used');
    }
    const proposal = ctx.db.tradeProposal.id.find(order.proposalId)!;
    const total = [...ctx.db.fill.iter()].filter(fill => fill.orderId === value.orderId)
      .reduce((sum, fill) => sum + decimal(fill.quantity, 6, true), quantity);
    if (total > decimal(proposal.quantity, 6, true)) throw new SenderError('Cumulative fills exceed order quantity');
    ctx.db.fill.insert(value);
  }
);

export const recordAccountSnapshot = spacetimedb.reducer(
  { id: t.string(), accountId: t.string(), accountStatus: t.string(), cash: t.string(),
    buyingPower: t.string(), equity: t.string(), dailyPnl: t.option(t.string()), positionsJson: t.string(), openOrdersJson: t.string(),
    observations: t.array(marketObservationInput) },
  (ctx, value) => {
    requireRole(ctx, ['executor', 'market_data', 'risk']); requireId(value.id);
    requireText(value.accountId, 'Account ID', 128); requireText(value.accountStatus, 'Account status', 64);
    requireText(value.cash, 'Cash', 64); requireText(value.buyingPower, 'Buying power', 64);
    requireText(value.equity, 'Equity', 64);
    if (value.dailyPnl !== undefined && (value.dailyPnl.length > 64 || !/^-?(0|[1-9]\d*)(\.\d{1,12})?$/.test(value.dailyPnl))) {
      throw new SenderError('Invalid daily P&L');
    }
    if (!ctx.db.accountAccess.id.find(`${ctx.sender.toHexString()}:${value.accountId}`)) throw new SenderError('Account access required');
    decimal(value.buyingPower, 12); decimal(value.equity, 12);
    if (!/^-?(0|[1-9]\d*)(\.\d{1,12})?$/.test(value.cash)) throw new SenderError('Invalid cash');
    parsePositions(value.positionsJson); parseOpenOrders(value.openOrdersJson);
    if (value.positionsJson.length > 1_000_000 || value.openOrdersJson.length > 1_000_000) {
      throw new SenderError('Account snapshot payload is too large');
    }
    try {
      if (!Array.isArray(JSON.parse(value.positionsJson)) || !Array.isArray(JSON.parse(value.openOrdersJson))) {
        throw new Error('expected arrays');
      }
    } catch {
      throw new SenderError('Positions and open orders must be JSON arrays');
    }
    if (value.observations.length > 50) throw new SenderError('Too many market observations');
    if (ctx.db.agent.identity.find(ctx.sender)?.role === 'market_data' && value.observations.length === 0) {
      throw new SenderError('Market-data snapshots must include observations');
    }
    const symbols = new Set<string>();
    for (const observation of value.observations) {
      requireId(observation.id);
      if (observation.asOf.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('Future-dated market observation');
      if (!/^[A-Z][A-Z0-9.-]{0,15}$/.test(observation.symbol)) throw new SenderError('Invalid symbol');
      if (symbols.has(observation.symbol)) throw new SenderError('Duplicate market observation symbol');
      symbols.add(observation.symbol);
      if (!['sip', 'iex', 'delayed_sip', 'boats', 'overnight', 'otc'].includes(observation.feed)) {
        throw new SenderError('Invalid market-data feed');
      }
      for (const [label, amount] of [['Bid price', observation.bidPrice], ['Ask price', observation.askPrice]] as const) {
        if (!/^(0|[1-9]\d*)(\.\d{1,12})?$/.test(amount)) throw new SenderError(`${label} is invalid`);
      }
      for (const [label, amount] of [['Bid size', observation.bidSize], ['Ask size', observation.askSize]] as const) {
        if (!/^(0|[1-9]\d*)$/.test(amount)) throw new SenderError(`${label} is invalid`);
      }
      if (ctx.db.marketObservation.id.find(observation.id)) throw new SenderError('Market observation already exists');
    }
    if (ctx.db.accountSnapshot.id.find(value.id)) throw new SenderError('Snapshot already exists');
    const { observations, ...snapshot } = value;
    ctx.db.accountSnapshot.insert({ ...snapshot, dailyPnl: value.dailyPnl, capturedAt: ctx.timestamp });
    for (const observation of observations) {
      ctx.db.marketObservation.insert({ ...observation, snapshotId: value.id, capturedAt: ctx.timestamp });
    }
  }
);

export const recordReconciliation = spacetimedb.reducer(
  { id: t.string(), accountId: t.string(), status: t.string(), details: t.string() },
  (ctx, value) => {
    requireRole(ctx, ['executor']); requireId(value.id);
    if (!ctx.db.accountAccess.id.find(`${ctx.sender.toHexString()}:${value.accountId}`)) throw new SenderError('Account access required');
    if (ctx.db.reconciliation.id.find(value.id)) throw new SenderError('Reconciliation already exists');
    if (!['matched', 'mismatch', 'resolved'].includes(value.status)) throw new SenderError('Invalid reconciliation status');
    requireText(value.details, 'Reconciliation details');
    ctx.db.reconciliation.insert({ ...value, capturedAt: ctx.timestamp });
    if(value.status==='mismatch'){
      const check={accountId:value.accountId,status:'mismatch',details:value.details,checkedAt:ctx.timestamp};
      if(ctx.db.accountCheck.accountId.find(value.accountId))ctx.db.accountCheck.accountId.update(check);else ctx.db.accountCheck.insert(check);
    }
  }
);

export const recordRunMetric = spacetimedb.reducer(
  { id: t.string(), runId: t.string(), name: t.string(), value: t.string() },
  (ctx, value) => {
    requireRole(ctx, ['operator', 'coordinator', 'risk']); requireId(value.id);
    requireRunAccess(ctx, value.runId);
    if (!ctx.db.run.id.find(value.runId)) throw new SenderError('Run not found');
    if (ctx.db.runMetric.id.find(value.id)) throw new SenderError('Metric already exists');
    requireText(value.name, 'Metric name', 128); requireText(value.value, 'Metric value', 128);
    ctx.db.runMetric.insert({ ...value, observedAt: ctx.timestamp });
  }
);
