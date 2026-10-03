import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimal, validOrderTransition } from '../spacetimedb/src/domain.ts';
import { recordId } from './ids.ts';
import { isPermanent, PermanentWorkError, DeferredWorkError } from './work-errors.ts';

test('fill arithmetic is exact and rejects malformed, negative, or overprecision decimals', () => {
  assert.equal(decimal('0.1', 6) + decimal('0.2', 6), decimal('0.3', 6));
  for (const value of ['-1', 'NaN', '1e3', '0.0000001', '']) assert.throws(() => decimal(value, 6, true));
  assert.throws(() => decimal('0', 6, true));
});
test('orders cannot regress from partial fills, change terminal status, or use unknown states', () => {
  assert.equal(validOrderTransition('accepted', 'partially_filled'), true);
  assert.equal(validOrderTransition('partially_filled', 'accepted'), false);
  assert.equal(validOrderTransition('filled', 'accepted'), false);
  assert.equal(validOrderTransition('replaced', 'new'), false);
  assert.equal(validOrderTransition('made-up', 'made-up'), false);
});
test('derived protocol IDs preserve short records and bound long task chains', () => {
  assert.equal(recordId('thesis.', 'task-1'), 'thesis.task-1');
  const a = recordId('decision.', recordId('thesis.', 'x'.repeat(128)), '.msg');
  assert.ok(a.length <= 128);
  assert.equal(a, recordId('decision.', recordId('thesis.', 'x'.repeat(128)), '.msg'));
  assert.notEqual(a, recordId('decision.', recordId('thesis.', 'y'.repeat(128)), '.msg'));
});
test('temporary provider failures defer work and permanent errors end bounded retries', () => {
  assert.equal(isPermanent({ status: 429 }), false);
  assert.equal(isPermanent({ status: 503 }), false);
  assert.equal(isPermanent({ status: 401 }), true);
  assert.equal(isPermanent(new DeferredWorkError('paused')), false);
  assert.equal(isPermanent(new PermanentWorkError('bad output')), true);
});
