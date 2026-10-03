import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from './schema';
import { parseRefs, requireEvidence, requireId, requireRole, requireRun, requireSymbol, requireText } from './access';

const marketObservationInput = t.object('MarketObservationInput', {
  id: t.string(), symbol: t.string(), feed: t.string(), bidPrice: t.string(), bidSize: t.string(),
  askPrice: t.string(), askSize: t.string(), asOf: t.timestamp(),
});

export const addSource = spacetimedb.reducer(
  { id: t.string(), runId: t.string(), symbol: t.string(), kind: t.string(), uri: t.string(),
    asOf: t.timestamp(), checksum: t.string(), artifactRef: t.string() },
  (ctx, value) => {
    requireRole(ctx, ['ingestor']); requireRun(ctx, value.runId); requireId(value.id);
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
    requireText(value.invalidation, 'Invalidation');
    // A thesis must cite at least one stored source or fact for its own symbol.
    const refs = parseRefs(value.evidenceRefs);
    if (refs.length === 0) throw new SenderError('Thesis needs at least one evidence reference');
    requireEvidence(ctx, refs, value.symbol, ['source', 'fact']);
    if (value.taskId) {
      const linkedTask = ctx.db.task.id.find(value.taskId);
      if (!linkedTask || linkedTask.runId !== value.runId || linkedTask.symbol !== value.symbol) throw new SenderError('Task mismatch');
      if (linkedTask.status !== 'claimed' || !linkedTask.assignee?.equals(ctx.sender)) throw new SenderError('Task not owned');
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

export const recordDecision = spacetimedb.reducer(
  { id: t.string(), thesisId: t.string(), outcome: t.string(), rationale: t.string() },
  (ctx, value) => {
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
);

export const proposeTrade = spacetimedb.reducer(
  { id: t.string(), runId: t.string(), thesisId: t.string(), symbol: t.string(), side: t.string(),
    quantity: t.string(), orderType: t.string(), limitPrice: t.string() },
  (ctx, value) => {
    requireRole(ctx, ['coordinator']); requireRun(ctx, value.runId); requireId(value.id);
    const linkedThesis = ctx.db.thesis.id.find(value.thesisId);
    if (!linkedThesis || linkedThesis.runId !== value.runId || linkedThesis.symbol !== value.symbol) throw new SenderError('Thesis mismatch');
    if (ctx.db.decision.thesisId.find(value.thesisId)?.outcome !== 'trade') throw new SenderError('Trade decision required');
    if (!['buy', 'sell'].includes(value.side) || !['market', 'limit'].includes(value.orderType)) throw new SenderError('Invalid order parameters');
    if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value.quantity) || Number(value.quantity) <= 0) throw new SenderError('Invalid quantity');
    if (value.orderType === 'limit' && (!/^(0|[1-9]\d*)(\.\d{1,4})?$/.test(value.limitPrice) || Number(value.limitPrice) <= 0)) throw new SenderError('Invalid limit price');
    if (value.orderType === 'market' && value.limitPrice !== '') throw new SenderError('Market order cannot have limit price');
    if (ctx.db.tradeProposal.id.find(value.id)) throw new SenderError('Proposal already exists');
    ctx.db.tradeProposal.insert({ ...value, status: 'proposed', proposedBy: ctx.sender, createdAt: ctx.timestamp });
  }
);

export const recordRiskDecision = spacetimedb.reducer(
  { id: t.string(), proposalId: t.string(), policyVersion: t.string(), outcome: t.string(),
    checks: t.string(), expiresAt: t.timestamp() },
  (ctx, value) => {
    requireRole(ctx, ['risk']); requireId(value.id);
    const proposal = ctx.db.tradeProposal.id.find(value.proposalId);
    if (!proposal || proposal.status !== 'proposed') throw new SenderError('Proposal is not awaiting risk review');
    requireRun(ctx, proposal.runId);
    if (!['pass', 'reject'].includes(value.outcome)) throw new SenderError('Invalid risk outcome');
    requireText(value.policyVersion, 'Policy version', 128); requireText(value.checks, 'Checks');
    if (value.expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('Risk decision already expired');
    if (ctx.db.riskDecision.proposalId.find(value.proposalId)) throw new SenderError('Risk decision already exists');
    ctx.db.riskDecision.insert({ ...value, reviewer: ctx.sender, decidedAt: ctx.timestamp });
    ctx.db.tradeProposal.id.update({ ...proposal, status: value.outcome === 'pass' ? 'risk_passed' : 'rejected' });
  }
);

export const approveProposal = spacetimedb.reducer({ proposalId: t.string() }, (ctx, { proposalId }) => {
  requireRole(ctx, ['operator']);
  const proposal = ctx.db.tradeProposal.id.find(proposalId);
  if (!proposal || proposal.status !== 'risk_passed') throw new SenderError('Proposal is not risk passed');
  requireRun(ctx, proposal.runId);
  const risk = ctx.db.riskDecision.proposalId.find(proposalId);
  if (!risk || risk.outcome !== 'pass' || risk.expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('Risk approval expired');
  if (ctx.db.approval.proposalId.find(proposalId)) throw new SenderError('Already approved');
  ctx.db.approval.insert({ proposalId, approver: ctx.sender, riskDecisionId: risk.id, approvedAt: ctx.timestamp });
  ctx.db.tradeProposal.id.update({ ...proposal, status: 'approved' });
});

export const reservePaperOrder = spacetimedb.reducer(
  { id: t.string(), proposalId: t.string(), clientOrderId: t.string() },
  (ctx, value) => {
    requireRole(ctx, ['executor']); requireId(value.id); requireText(value.clientOrderId, 'Client order ID', 128);
    const proposal = ctx.db.tradeProposal.id.find(value.proposalId);
    if (!proposal || proposal.status !== 'approved') throw new SenderError('Proposal is not approved');
    requireRun(ctx, proposal.runId);
    const risk = ctx.db.riskDecision.proposalId.find(value.proposalId);
    if (!risk || risk.outcome !== 'pass' || risk.expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('Risk approval expired');
    if (!ctx.db.approval.proposalId.find(value.proposalId)) throw new SenderError('Operator approval required');
    if (ctx.db.paperOrder.proposalId.find(value.proposalId) || ctx.db.paperOrder.clientOrderId.find(value.clientOrderId)) throw new SenderError('Order intent already reserved');
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
    if (!['submitting', 'accepted', 'pending_cancel', 'partially_filled', 'filled', 'canceled', 'expired', 'rejected', 'replaced', 'done_for_day'].includes(status)) throw new SenderError('Invalid order status');
    if (['filled', 'canceled', 'expired', 'rejected'].includes(existing.status) && status !== existing.status) throw new SenderError('Terminal order cannot regress');
    ctx.db.paperOrder.id.update({ ...existing, alpacaOrderId, status, updatedAt: ctx.timestamp });
  }
);

export const recordFill = spacetimedb.reducer(
  { id: t.string(), orderId: t.string(), alpacaActivityId: t.string(), quantity: t.string(),
    price: t.string(), filledAt: t.timestamp() },
  (ctx, value) => {
    requireRole(ctx, ['executor']); requireId(value.id);
    if (!ctx.db.paperOrder.id.find(value.orderId)) throw new SenderError('Order not found');
    const existing = ctx.db.fill.alpacaActivityId.find(value.alpacaActivityId);
    if (existing) {
      if (existing.id === value.id && existing.orderId === value.orderId && existing.quantity === value.quantity && existing.price === value.price) return;
      throw new SenderError('Activity ID already used');
    }
    ctx.db.fill.insert(value);
  }
);

export const recordAccountSnapshot = spacetimedb.reducer(
  { id: t.string(), accountId: t.string(), accountStatus: t.string(), cash: t.string(),
    buyingPower: t.string(), equity: t.string(), positionsJson: t.string(), openOrdersJson: t.string(),
    observations: t.array(marketObservationInput) },
  (ctx, value) => {
    requireRole(ctx, ['executor', 'market_data']); requireId(value.id);
    requireText(value.accountId, 'Account ID', 128); requireText(value.accountStatus, 'Account status', 64);
    requireText(value.cash, 'Cash', 64); requireText(value.buyingPower, 'Buying power', 64);
    requireText(value.equity, 'Equity', 64);
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
    ctx.db.accountSnapshot.insert({ ...snapshot, capturedAt: ctx.timestamp });
    for (const observation of observations) {
      ctx.db.marketObservation.insert({ ...observation, snapshotId: value.id, capturedAt: ctx.timestamp });
    }
  }
);

export const recordReconciliation = spacetimedb.reducer(
  { id: t.string(), status: t.string(), details: t.string() },
  (ctx, value) => {
    requireRole(ctx, ['executor']); requireId(value.id);
    if (ctx.db.reconciliation.id.find(value.id)) throw new SenderError('Reconciliation already exists');
    ctx.db.reconciliation.insert({ ...value, capturedAt: ctx.timestamp });
  }
);

export const recordRunMetric = spacetimedb.reducer(
  { id: t.string(), runId: t.string(), name: t.string(), value: t.string() },
  (ctx, value) => {
    requireRole(ctx, ['operator', 'coordinator', 'risk']); requireId(value.id);
    if (!ctx.db.run.id.find(value.runId)) throw new SenderError('Run not found');
    if (ctx.db.runMetric.id.find(value.id)) throw new SenderError('Metric already exists');
    ctx.db.runMetric.insert({ ...value, observedAt: ctx.timestamp });
  }
);
