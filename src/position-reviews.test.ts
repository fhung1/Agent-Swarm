import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPositionReviews, type ReviewFill, type ReviewProposal } from './position-reviews.ts';

const now = new Date('2026-10-03T16:00:00Z');
const proposal: ReviewProposal = { id: 'proposal.aapl', runId: 'run-1', thesisId: 'thesis.aapl',
  symbol: 'AAPL', side: 'buy', createdAt: new Date('2026-09-01T16:00:00Z'), thesisTaskId: 'thesis-task-aapl' };
const fill: ReviewFill = { id: 'fill-a', orderId: 'order-a', quantity: 2, price: 100,
  at: new Date('2026-09-01T16:01:00Z') };
const base = { runId: 'run-1', now, config: { everyDays: 30, priceMovePct: 10 },
  proposals: [proposal], orders: [{ id: 'order-a', proposalId: proposal.id }], fills: [fill],
  positions: [{ symbol: 'AAPL', qty: 2, marketValue: 210 }], markers: [], quotes: [], tasks: [] };

test('held filled positions get one stable review trigger and preserve the original thesis dependency', () => {
  const [first] = planPositionReviews(base);
  assert.match(first.id, /^position-review\./);
  assert.equal(first.dependsOn, 'thesis-task-aapl');
  assert.match(first.objective, /hold or exit/);
  assert.match(first.objective, /broker fill/);
  assert.deepEqual(planPositionReviews({ ...base, tasks: [{ id: first.id, status: 'open' }] }), []);
  const next = planPositionReviews({ ...base, tasks: [{ id: first.id, status: 'completed' }] });
  assert.match(next[0].objective, /review cycle/);
  assert.notEqual(next[0].id, first.id);
});

test('unfilled buys, sells and flat positions do not create reviews', () => {
  assert.deepEqual(planPositionReviews({ ...base, fills: [] }), []);
  assert.deepEqual(planPositionReviews({ ...base, proposals: [{ ...proposal, side: 'sell' }] }), []);
  assert.deepEqual(planPositionReviews({ ...base, positions: [{ symbol: 'AAPL', qty: 0, marketValue: 0 }] }), []);
});

test('filing, price, drift, fill and cadence signals are distinct and idempotent', () => {
  const markers = [{ id: 'sec-marker-1', symbol: 'AAPL', asOf: new Date('2026-09-10T00:00:00Z') }];
  const quotes = [{ id: 'quote-1', symbol: 'AAPL', bid: 120, asOf: new Date('2026-10-03T15:59:00Z') }];
  const input = { ...base, markers, quotes, maxPositionNotional: 200 };
  const seen: { id: string; status: string }[] = [];
  const reasons: string[] = [];
  for (let i = 0; i < 5; i++) {
    const [task] = planPositionReviews({ ...input, tasks: seen });
    assert.ok(task);
    reasons.push(task.objective);
    seen.push({ id: task.id, status: 'completed' });
  }
  assert.match(reasons[0], /exceeds policy/);
  assert.match(reasons[1], /new filing marker/);
  assert.match(reasons[2], /moved at least/);
  assert.match(reasons[3], /broker fill/);
  assert.match(reasons[4], /review cycle/);
  assert.deepEqual(planPositionReviews({ ...input, tasks: seen }), []);
});

test('stale quotes and pre-entry filings cannot trigger a review', () => {
  const output = planPositionReviews({ ...base,
    markers: [{ id: 'old', symbol: 'AAPL', asOf: new Date('2026-08-01T00:00:00Z') }],
    quotes: [{ id: 'stale', symbol: 'AAPL', bid: 130, asOf: new Date('2026-10-01T00:00:00Z') }] });
  assert.match(output[0].objective, /broker fill/);
});

test('closed and externally mismatched lots are not linked to a different held position', () => {
  const sell = { ...proposal, id: 'proposal.sell', side: 'sell', thesisId: 'exit-thesis' };
  const newer = { ...proposal, id: 'proposal.new', thesisId: 'new-thesis' };
  const fills = [fill,
    { id: 'fill-sell', orderId: 'order-sell', quantity: 2, price: 110, at: new Date('2026-09-15T16:00:00Z') },
    { id: 'fill-new', orderId: 'order-new', quantity: 1, price: 120, at: new Date('2026-10-01T16:00:00Z') }];
  const input = { ...base, proposals: [proposal, sell, newer],
    orders: [...base.orders, { id: 'order-sell', proposalId: sell.id }, { id: 'order-new', proposalId: newer.id }],
    fills, positions: [{ symbol: 'AAPL', qty: 1, marketValue: 121 }] };
  const planned = planPositionReviews(input);
  assert.equal(planned.length, 1);
  assert.match(planned[0].objective, /proposal.new/);
  assert.deepEqual(planPositionReviews({ ...input, positions: [{ symbol: 'AAPL', qty: 2, marketValue: 242 }] }), []);
});
