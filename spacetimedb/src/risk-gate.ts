import { SenderError } from 'spacetimedb/server';
import { evaluateRisk, type RiskPolicy, type PendingIntent } from './risk';
import type { Ctx } from './access';

export function evaluateProposal(ctx: Ctx, proposalId: string) {
  const proposal = ctx.db.tradeProposal.id.find(proposalId);
  if (!proposal) throw new SenderError('Proposal not found');
  const config = ctx.db.runConfig.runId.find(proposal.runId);
  const policyRow = config && ctx.db.riskPolicy.id.find(config.policyId);
  if (!policyRow || policyRow.runId !== proposal.runId) throw new SenderError('Configured risk policy required');
  const policy = JSON.parse(policyRow.policyJson) as RiskPolicy;
  const snapshots = [...ctx.db.accountSnapshot.accountId.filter(policyRow.accountId)]
    .sort((a, b) => Number(b.capturedAt.microsSinceUnixEpoch - a.capturedAt.microsSinceUnixEpoch));
  const snapshot = snapshots[0];
  if (!snapshot) throw new SenderError('Account snapshot required');
  const quotes = [...ctx.db.marketObservation.snapshotId.filter(snapshot.id)].map(q => ({ ...q, asOf: q.asOf.toDate() }));
  const quote = quotes.find(q => q.symbol === proposal.symbol);
  if (!quote) throw new SenderError('Snapshot quote required');
  const pendingIntents: PendingIntent[] = [];
  for (const reservation of ctx.db.riskReservation.accountId.filter(policyRow.accountId)) {
    if (reservation.proposalId === proposalId) continue;
    const other = ctx.db.tradeProposal.id.find(reservation.proposalId);
    const risk = ctx.db.riskDecision.proposalId.find(reservation.proposalId);
    if (!other || !risk) throw new SenderError('Broken reservation');
    const order = ctx.db.paperOrder.proposalId.find(other.id);
    if (order && ['filled', 'canceled', 'expired', 'rejected', 'replaced'].includes(order.status)) continue;
    // Once submission is uncertain, retain cash/shares even after the approval TTL expires.
    if (!order && risk.expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) continue;
    pendingIntents.push({ proposalId: other.id, symbol: other.symbol, side: other.side,
      quantity: reservation.quantity, notional: reservation.notional, clientOrderId: reservation.clientOrderId });
  }
  const clock = ctx.db.marketClock.accountId.find(policyRow.accountId);
  const clockAge = clock ? ctx.timestamp.microsSinceUnixEpoch - clock.asOf.microsSinceUnixEpoch : -1n;
  const result = evaluateRisk({ proposal: { ...proposal, createdAt: proposal.createdAt.toDate() }, quote, quotes, pendingIntents,
    account: { ...snapshot, dailyPnl: snapshot.dailyPnl ?? undefined,
      status: snapshot.accountStatus, capturedAt: snapshot.capturedAt.toDate() },
    marketOpen: !!clock && clock.isOpen && clockAge >= 0n && clockAge <= 60_000_000n,
    runStatus: ctx.db.run.id.find(proposal.runId)?.status ?? '', now: ctx.timestamp.toDate() }, policy);
  const price = proposal.orderType === 'limit' ? Number(proposal.limitPrice) : Number(proposal.side === 'buy' ? quote.askPrice : quote.bidPrice);
  return { result, policyRow, snapshot, quote, notional: String(Number(proposal.quantity) * price) };
}

export function requireCurrentRisk(ctx: Ctx, proposalId: string): void {
  const risk = ctx.db.riskDecision.proposalId.find(proposalId);
  if (!risk || risk.outcome !== 'pass' || risk.expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('Risk approval expired');
  const current = evaluateProposal(ctx, proposalId);
  if(ctx.db.accountCheck.accountId.find(current.policyRow.accountId)?.status==='mismatch')throw new SenderError('Account reconciliation mismatch blocks trading');
  if (risk.policyId !== current.policyRow.id || risk.snapshotId !== current.snapshot.id || risk.quoteId !== current.quote.id) {
    throw new SenderError('Risk inputs changed; fresh review required');
  }
  if (current.result.outcome !== 'pass') throw new SenderError('Current risk checks reject proposal');
}
