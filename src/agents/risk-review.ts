import { z } from 'zod';
import { evaluateRisk, type AccountInput, type PendingIntent, type QuoteInput, type RiskPolicy, type RiskResult } from './risk.ts';

// The risk broker's local view of a review. It mirrors the module's evaluateProposal
// (spacetimedb/src/risk-gate.ts), which recomputes every decision authoritatively; the worker's
// verdict must match it, so any change there must be reflected here.

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,15}$/;
const positiveMs = z.number().int().positive();

// Validates a policy file before an operator provisions it with add_risk_policy.
export const RiskPolicySchema = z.object({
  version: z.string().min(1).max(128),
  allowedSymbols: z.array(z.string().regex(SYMBOL)).min(1),
  longOnly: z.boolean(),
  maxOrderNotional: z.number().positive(),
  maxPositionNotional: z.number().positive(),
  maxQuoteAgeMs: positiveMs,
  maxAccountAgeMs: positiveMs,
  maxLimitDeviation: z.number().positive().max(1),
  approvalTtlMs: positiveMs,
  maxProposalAgeMs: positiveMs,
  requireMarketOpen: z.boolean(),
  maxPortfolioNotional: z.number().positive().optional(),
  maxOpenOrders: z.number().int().positive().optional(),
  maxDailyLoss: z.number().positive().optional(),
}).strict();

export function parseRiskPolicy(json: string): RiskPolicy {
  return RiskPolicySchema.parse(JSON.parse(json));
}

export interface ProposalView {
  id: string; runId: string; thesisId: string; symbol: string; side: string; quantity: string;
  orderType: string; limitPrice: string; status: string; createdAt: Date;
}
export interface ReservationView { proposalId: string; accountId: string; quantity: string; notional: string; clientOrderId: string }
export interface RiskDecisionView { id: string; proposalId: string; outcome: string; expiresAt: Date; policyId: string; snapshotId: string }
export interface PaperOrderView { proposalId: string; status: string }

const TERMINAL_ORDER = new Set(['filled', 'canceled', 'expired', 'rejected', 'replaced']);

// Same rules as the module: skip the proposal under review, released terminal orders, and expired passes
// that never reached the broker; keep any intent whose submission may be in flight.
export function pendingIntentsFor(
  proposalId: string, accountId: string, reservations: ReservationView[],
  proposals: Map<string, ProposalView>, decisions: Map<string, RiskDecisionView>, orders: Map<string, PaperOrderView>, now: Date,
): PendingIntent[] {
  const intents: PendingIntent[] = [];
  for (const reservation of reservations) {
    if (reservation.accountId !== accountId || reservation.proposalId === proposalId) continue;
    const other = proposals.get(reservation.proposalId);
    const risk = decisions.get(reservation.proposalId);
    if (!other || !risk) throw new Error(`Reservation ${reservation.proposalId} has no visible proposal or risk decision`);
    const order = orders.get(other.id);
    if (order && TERMINAL_ORDER.has(order.status)) continue;
    if (!order && risk.expiresAt.getTime() <= now.getTime()) continue;
    intents.push({ proposalId: other.id, symbol: other.symbol, side: other.side,
      quantity: reservation.quantity, notional: reservation.notional, clientOrderId: reservation.clientOrderId });
  }
  return intents;
}

export interface ReviewInput {
  proposal: ProposalView; runStatus: string; policy: RiskPolicy;
  account: AccountInput; quotes: QuoteInput[]; pendingIntents: PendingIntent[]; marketOpen: boolean; now: Date;
}

export function reviewProposal(input: ReviewInput): RiskResult & { failed: string[] } {
  const quote = input.quotes.find(q => q.symbol === input.proposal.symbol);
  const result = evaluateRisk({
    proposal: input.proposal, quote, quotes: input.quotes, pendingIntents: input.pendingIntents,
    account: input.account, marketOpen: input.marketOpen, runStatus: input.runStatus, now: input.now,
  }, input.policy);
  return { ...result, failed: result.checks.filter(c => !c.pass).map(c => c.name) };
}

// A passed proposal with no order needs a fresh decision once its pass expires or its pinned inputs are superseded.
export function needsRefresh(
  decision: RiskDecisionView | undefined, order: PaperOrderView | undefined,
  latestSnapshotId: string | undefined, currentPolicyId: string, now: Date,
): boolean {
  if (!decision || order) return false;
  return decision.expiresAt.getTime() <= now.getTime() || decision.snapshotId !== latestSnapshotId || decision.policyId !== currentPolicyId;
}

export function summarize(proposal: ProposalView, outcome: string, failed: string[], policyId: string, expiresAt: Date): string {
  const order = `${proposal.side} ${proposal.quantity} ${proposal.symbol} ${proposal.orderType}` +
    (proposal.limitPrice ? ` @ ${proposal.limitPrice}` : '');
  return `Risk ${outcome} for ${proposal.id} (${order}) under policy ${policyId}` +
    (failed.length ? `; failed: ${failed.join(', ')}` : '') +
    (outcome === 'pass' ? `; valid until ${expiresAt.toISOString()}` : '');
}
