import test from 'node:test';
import assert from 'node:assert/strict';
import {isUsefulPeerEvent} from './communication.ts';
test('research selection is useful peer coordination', () => {
  assert.equal(isUsefulPeerEvent('action_result', {status: 'completed', technology: 'automation'}), true);
  assert.equal(isUsefulPeerEvent('action_result', {status: 'completed'}), false);
});
