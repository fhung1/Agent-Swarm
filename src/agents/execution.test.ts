import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySubmitFailure, clientOrderIdFor, filledQuantity, newFills, nextStatus, orderRequestFor, paperOrderIdFor, sameQuantity,
} from './execution.ts';

const proposal = { id: 'proposal.th-1', symbol: 'AAPL', side: 'buy', quantity: '2', orderType: 'market', limitPrice: '' };

test('client order IDs are deterministic, distinct, and within Alpaca limits', () => {
  const id = clientOrderIdFor(proposal.id);
  assert.equal(id, clientOrderIdFor(proposal.id));
  assert.notEqual(id, clientOrderIdFor('proposal.th-2'));
  assert.ok(id.length <= 128 && /^qs-[0-9a-f]{40}$/.test(id));
  assert.equal(paperOrderIdFor(proposal.id), 'order.proposal.th-1');
  assert.ok(paperOrderIdFor('x'.repeat(200)).length <= 128);
});

test('order requests are day orders with string amounts', () => {
  assert.deepEqual(orderRequestFor(proposal, 'qs-1'), {
    symbol: 'AAPL', qty: '2', side: 'buy', type: 'market', time_in_force: 'day', client_order_id: 'qs-1', extended_hours: false,
  });
  assert.equal(orderRequestFor({ ...proposal, orderType: 'limit', limitPrice: '199.5' }, 'qs-1').limit_price, '199.5');
  assert.throws(() => orderRequestFor({ ...proposal, quantity: '1e3' }, 'qs-1'));
  assert.throws(() => orderRequestFor({ ...proposal, orderType: 'stop' }, 'qs-1'));
});

test('broker statuses map onto valid recorded transitions only', () => {
  assert.equal(nextStatus('submitting', 'new'), 'new');
  assert.equal(nextStatus('new', 'partially_filled'), 'partially_filled');
  assert.equal(nextStatus('partially_filled', 'filled'), 'filled');
  assert.equal(nextStatus('new', 'new'), undefined);
  assert.equal(nextStatus('new', 'held'), undefined);
  assert.equal(nextStatus('filled', 'canceled'), undefined);
  assert.equal(nextStatus('partially_filled', 'rejected'), undefined);
});

test('submit failures distinguish refusals, duplicates, retries, and uncertainty', () => {
  assert.equal(classifySubmitFailure({ status: 403, body: 'insufficient buying power' }), 'refused');
  assert.equal(classifySubmitFailure({ status: 422, body: 'qty must be > 0' }), 'refused');
  assert.equal(classifySubmitFailure({ status: 422, body: 'client_order_id must be unique' }), 'duplicate');
  assert.equal(classifySubmitFailure({ status: 401, body: 'unauthorized' }), 'retry');
  assert.equal(classifySubmitFailure({ status: 500, body: 'oops' }), 'uncertain');
  assert.equal(classifySubmitFailure(new Error('The operation was aborted due to timeout')), 'uncertain');
});

test('new fills skip recorded and foreign activities and validate decimals', () => {
  const activities = [
    { id: 'a1', activity_type: 'FILL', order_id: 'ord-1', qty: '1', price: '200.05', transaction_time: '2026-10-05T15:00:01Z' },
    { id: 'a2', activity_type: 'FILL', order_id: 'ord-1', qty: '1', price: '200.07', transaction_time: '2026-10-05T15:00:02Z' },
    { id: 'a3', activity_type: 'FILL', order_id: 'ord-2', qty: '5', price: '10', transaction_time: '2026-10-05T15:00:03Z' },
  ];
  const fills = newFills(activities, 'order.p', 'ord-1', new Set(['a1']));
  assert.deepEqual(fills.map(f => [f.id, f.alpacaActivityId, f.quantity, f.price]), [['fill.a2', 'a2', '1', '200.07']]);
  assert.throws(() => newFills([{ ...activities[0], qty: '0.1234567' }], 'order.p', 'ord-1', new Set()));
});

test('fill totals use exact decimals', () => {
  assert.equal(filledQuantity(['0.1', '0.2']), 300000n);
  assert.ok(sameQuantity('0.3', '0.300000'));
  assert.ok(!sameQuantity('1', '0.999999'));
});
