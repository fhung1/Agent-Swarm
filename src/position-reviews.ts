import { recordId } from './ids.ts';
import { createHash } from 'node:crypto';

export interface PositionReviewConfig { everyDays: number; priceMovePct: number }
export interface ReviewProposal { id: string; runId: string; thesisId: string; symbol: string; side: string; createdAt: Date; thesisTaskId: string }
export interface ReviewFill { orderId: string; id: string; quantity: number; price: number; at: Date }
export interface ReviewOrder { id: string; proposalId: string }
export interface ReviewPosition { symbol: string; qty: number; marketValue: number }
export interface ReviewMarker { id: string; symbol: string; asOf: Date }
export interface ReviewQuote { id: string; symbol: string; bid: number; asOf: Date }
export interface ReviewTask { id: string; status: string }
export interface ReviewTaskSpec { id: string; runId: string; symbol: string; kind: 'position_review'; objective: string; role: 'analyst'; dependsOn: string }

const DAY_MS = 86_400_000;
const symbol = /^[A-Z][A-Z0-9.-]{0,15}$/;

export function planPositionReviews(input: {
  runId: string; now: Date; config: PositionReviewConfig; proposals: ReviewProposal[]; orders: ReviewOrder[];
  fills: ReviewFill[]; positions: ReviewPosition[]; markers: ReviewMarker[]; quotes: ReviewQuote[];
  tasks: ReviewTask[]; maxPositionNotional?: number;
}): ReviewTaskSpec[] {
  const { runId, now, config } = input;
  if (!Number.isInteger(config.everyDays) || config.everyDays < 1 || config.everyDays > 365 ||
      !Number.isFinite(config.priceMovePct) || config.priceMovePct <= 0 || config.priceMovePct > 100) {
    throw new Error('Invalid position review cadence or price threshold');
  }
  const taskById = new Map(input.tasks.map(task => [task.id, task]));
  const positions = new Map(input.positions.map(position => [position.symbol, position]));
  const orders = new Map(input.orders.map(order => [order.proposalId, order]));
  const proposalByOrder = new Map(input.orders.map(order => [order.id, input.proposals.find(p => p.id === order.proposalId)]));
  const lots = new Map<string, { proposalId: string; remaining: number }[]>();
  const unmatched = new Set<string>();
  for (const fill of [...input.fills].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id))) {
    const proposal = proposalByOrder.get(fill.orderId);
    if (!proposal || proposal.runId !== runId || !(fill.quantity > 0) || fill.at.getTime() > now.getTime()) continue;
    const queue = lots.get(proposal.symbol) ?? [];
    if (proposal.side === 'buy') queue.push({ proposalId: proposal.id, remaining: fill.quantity });
    if (proposal.side === 'sell') {
      let remaining = fill.quantity;
      for (const lot of queue) {
        const used = Math.min(lot.remaining, remaining);
        lot.remaining -= used;
        remaining -= used;
        if (remaining <= 1e-8) break;
      }
      if (remaining > 1e-8) unmatched.add(proposal.symbol);
    }
    lots.set(proposal.symbol, queue);
  }
  for (const [name, queue] of lots) {
    const held = positions.get(name)?.qty ?? 0;
    if (Math.abs(queue.reduce((sum, lot) => sum + lot.remaining, 0) - held) > 1e-6) unmatched.add(name);
  }
  const today = now.toISOString().slice(0, 10).replaceAll('-', '');
  const result: ReviewTaskSpec[] = [];
  for (const proposal of input.proposals.filter(p => p.runId === runId && p.side === 'buy').sort((a, b) => a.id.localeCompare(b.id))) {
    const position = positions.get(proposal.symbol);
    const order = orders.get(proposal.id);
    if (!position || !(position.qty > 0) || !order || !symbol.test(proposal.symbol) || !proposal.thesisTaskId ||
        unmatched.has(proposal.symbol) || !(lots.get(proposal.symbol)?.some(lot => lot.proposalId === proposal.id && lot.remaining > 1e-8))) continue;
    const fills = input.fills.filter(fill => fill.orderId === order.id && fill.quantity > 0 && fill.price > 0 &&
      fill.at.getTime() <= now.getTime()).sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
    if (!fills.length) continue;
    // One pending review per originating proposal; a completed task allows the next distinct signal.
    const prefix = `position-review.${createHash('sha256').update(proposal.id).digest('hex').slice(0, 16)}.`;
    if (input.tasks.some(task => task.id.startsWith(prefix) && ['open', 'claimed'].includes(task.status))) continue;
    const first = fills[0].at.getTime();
    const latestFill = fills.at(-1)!;
    const paid = fills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0);
    const quantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
    const entry = paid / quantity;
    const candidates: { key: string; reason: string }[] = [];
    if (input.maxPositionNotional && position.marketValue > input.maxPositionNotional) {
      candidates.push({ key: `drift.${today}`, reason: `position value ${position.marketValue} exceeds policy position cap ${input.maxPositionNotional}` });
    }
    const marker = input.markers.filter(m => m.symbol === proposal.symbol && m.asOf.getTime() >= first && m.asOf.getTime() <= now.getTime())
      .sort((a, b) => a.asOf.getTime() - b.asOf.getTime() || a.id.localeCompare(b.id));
    for (const item of marker) candidates.push({ key: `filing.${item.id}`, reason: `new filing marker ${item.id}` });
    const quote = input.quotes.filter(q => q.symbol === proposal.symbol && q.asOf.getTime() <= now.getTime() &&
      now.getTime() - q.asOf.getTime() <= 15 * 60_000 && q.bid > 0)
      .sort((a, b) => b.asOf.getTime() - a.asOf.getTime() || a.id.localeCompare(b.id))[0];
    if (quote && Math.abs(quote.bid / entry - 1) * 100 >= config.priceMovePct) {
      candidates.push({ key: `price.${today}`, reason: `bid ${quote.bid} moved at least ${config.priceMovePct}% from weighted fill price ${entry.toFixed(4)} (quote ${quote.id})` });
    }
    candidates.push({ key: `fill.${latestFill.id}`, reason: `broker fill ${latestFill.id}` });
    const cycle = Math.floor((now.getTime() - first) / (config.everyDays * DAY_MS));
    if (cycle >= 1) candidates.push({ key: `cadence.${cycle}`, reason: `${config.everyDays}-day review cycle ${cycle}` });
    for (const candidate of candidates) {
      const id = recordId(prefix, candidate.key);
      if (taskById.has(id)) continue;
      result.push({ id, runId, symbol: proposal.symbol, kind: 'position_review', role: 'analyst',
        dependsOn: proposal.thesisTaskId,
        objective: `Review held paper position ${proposal.symbol} (${position.qty} shares) linked to thesis ${proposal.thesisId} and proposal ${proposal.id}. Trigger: ${candidate.reason}. Reassess the original thesis, cite current evidence, and describe hold or exit conditions. An exit must be a sell proposal that passes the risk gate.` });
      break;
    }
  }
  return result;
}
