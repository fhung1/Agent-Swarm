import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTradeUpdate } from './trade-updates.ts';

const update = {
  stream: 'trade_updates',
  data: { event: 'partial_fill', execution_id: 'exec-1', timestamp: '2026-10-03T20:00:00Z', qty: '1', price: '100',
    order: { id: '11111111-1111-1111-1111-111111111111', client_order_id: 'qs-example', status: 'partially_filled', filled_qty: '1' } },
};

test('trade updates get stable content-derived IDs', () => {
  const first = parseTradeUpdate(update)!;
  const second = parseTradeUpdate(structuredClone(update))!;
  assert.equal(first.id, second.id);
  assert.equal(first.executionId, 'exec-1');
  assert.equal(first.brokerStatus, 'partially_filled');
});

test('non-trade messages are ignored and malformed events fail closed', () => {
  assert.equal(parseTradeUpdate({ stream: 'authorization', data: { status: 'authorized' } }), undefined);
  assert.throws(() => parseTradeUpdate({ ...update, data: { ...update.data, event: 'invented' } }), /Unsupported/);
  assert.throws(() => parseTradeUpdate({ ...update, data: { ...update.data, timestamp: 'invalid' } }), /timestamp/);
});
