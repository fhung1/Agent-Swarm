import { createHash } from 'node:crypto';
import { decimal, validOrderTransition } from '../../spacetimedb/src/domain.ts';
import { recordId } from '../ids.ts';

// Pure decisions for the paper executor. Order transitions and decimal rules are the module's own
// (spacetimedb/src/domain.ts), so the executor never proposes an update the database would refuse.

// Alpaca statuses the module records; others (held, calculated, accepted_for_bidding, stopped, suspended,
// pending_replace) are transient broker states that leave the recorded status unchanged.
const RECORDED = new Set(['pending_new', 'accepted', 'new', 'partially_filled', 'pending_cancel', 'done_for_day',
  'filled', 'canceled', 'expired', 'rejected', 'replaced']);
export const TERMINAL = new Set(['filled', 'canceled', 'expired', 'rejected', 'replaced']);

export interface ProposalOrder { id: string; symbol: string; side: string; quantity: string; orderType: string; limitPrice: string }

// Deterministic per proposal, so every retry after a timeout or restart targets the same broker order.
export function clientOrderIdFor(proposalId: string): string {
  return `qs-${createHash('sha256').update(proposalId).digest('hex').slice(0, 40)}`;
}

export function paperOrderIdFor(proposalId: string): string {
  return recordId('order.', proposalId);
}

export function orderRequestFor(proposal: ProposalOrder, clientOrderId: string) {
  if (proposal.side !== 'buy' && proposal.side !== 'sell') throw new Error(`Unsupported side ${proposal.side}`);
  if (proposal.orderType !== 'market' && proposal.orderType !== 'limit') throw new Error(`Unsupported order type ${proposal.orderType}`);
  decimal(proposal.quantity, 6, true);
  if (proposal.orderType === 'limit') decimal(proposal.limitPrice, 4, true);
  return {
    symbol: proposal.symbol, qty: proposal.quantity,
    side: proposal.side as 'buy' | 'sell', type: proposal.orderType as 'market' | 'limit',
    // Day orders are the only time in force Alpaca allows for fractional quantities.
    time_in_force: 'day' as const, client_order_id: clientOrderId, extended_hours: false as const,
    ...(proposal.orderType === 'limit' ? { limit_price: proposal.limitPrice } : {}),
  };
}

// The status to record for a broker status, or undefined when nothing should change.
export function nextStatus(current: string, brokerStatus: string): string | undefined {
  if (!RECORDED.has(brokerStatus) || brokerStatus === current) return undefined;
  return validOrderTransition(current, brokerStatus) ? brokerStatus : undefined;
}

export type SubmitFailure = 'refused' | 'duplicate' | 'retry' | 'uncertain';

// refused: the broker definitely created no order. duplicate: the client order ID already exists, so look it up.
// retry: a configuration or rate-limit problem that placed nothing. uncertain: the order may or may not exist.
export function classifySubmitFailure(error: unknown): SubmitFailure {
  const status = (error as { status?: unknown }).status;
  const body = String((error as { body?: unknown }).body ?? '');
  if (typeof status !== 'number') return 'uncertain';
  if (status === 422 && /client.?order.?id/i.test(body)) return 'duplicate';
  if (status === 401 || status === 429) return 'retry';
  if (status === 403 || status === 422 || status === 400) return 'refused';
  return 'uncertain';
}

export interface FillArgs { id: string; orderId: string; alpacaActivityId: string; quantity: string; price: string; filledAt: Date }

// Fill activities for one broker order that are not yet recorded, in the module's decimal formats.
export function newFills(activities: Record<string, unknown>[], paperOrderId: string, alpacaOrderId: string,
  recordedActivityIds: ReadonlySet<string>): FillArgs[] {
  const fills: FillArgs[] = [];
  for (const activity of activities) {
    if (activity.order_id !== alpacaOrderId || (activity.activity_type !== undefined && activity.activity_type !== 'FILL')) continue;
    const activityId = String(activity.id ?? '');
    if (!activityId || recordedActivityIds.has(activityId)) continue;
    const quantity = String(activity.qty ?? '');
    const price = String(activity.price ?? '');
    decimal(quantity, 6, true);
    decimal(price, 12, true);
    const filledAt = new Date(String(activity.transaction_time ?? ''));
    if (!Number.isFinite(filledAt.getTime())) throw new Error(`Fill ${activityId} has an invalid transaction time`);
    fills.push({ id: recordId('fill.', activityId), orderId: paperOrderId, alpacaActivityId: activityId, quantity, price, filledAt });
  }
  return fills;
}

export function filledQuantity(quantities: string[]): bigint {
  return quantities.reduce((sum, q) => sum + decimal(q, 6, true), 0n);
}

export function sameQuantity(a: string, b: string): boolean {
  return decimal(a, 6) === decimal(b, 6);
}
