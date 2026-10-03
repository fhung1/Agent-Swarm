import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeOperation, validateCommand, type Operation } from './protocol.js';
const operation: Operation = { version: 1, worldId: 'world-1', historyId: 'history-1', operationId: 'take-1', actorId: 12,
  command: { kind: 'take', targetId: 20, item: 'iron-ore', quantity: 5 } };
test('operation digest and request are stable across property insertion order', () => {
  assert.deepEqual(encodeOperation(operation), encodeOperation({ ...operation, command: { quantity: 5, item: 'iron-ore', targetId: 20, kind: 'take' } }));
  assert.match(encodeOperation(operation).digest, /^[a-f0-9]{64}$/);
  assert.notEqual(encodeOperation(operation).digest, encodeOperation({ ...operation, command: { ...operation.command, quantity: 6 } as Operation['command'] }).digest);
});
test('commands reject executable text, unexpected fields, unsupported items and unbounded arguments', () => {
  for (const command of [null, 'lua', { kind: 'lua', code: 'game.print(1)' }, { kind: 'move', x: Infinity, y: 0, maxTicks: 10 },
    { kind: 'move', x: 0, y: 0, maxTicks: 601 }, { kind: 'take', targetId: 1, item: 'iron-ore', quantity: 21 },
    { kind: 'put', targetId: 1, item: 'rocket-silo', quantity: 1 }, { kind: 'take', targetId: -1, item: 'coal', quantity: 1 },
    { kind: 'move', x: 0, y: 0, maxTicks: 10, lua: 'bad' }]) assert.throws(() => validateCommand(command));
});
test('envelopes reject injected identifiers and extra fields', () => {
  assert.throws(() => encodeOperation({ ...operation, operationId: '\"; game.print(1)' }));
  assert.throws(() => encodeOperation({ ...operation, actorId: 0 }));
  assert.throws(() => encodeOperation({ ...operation, extra: true } as Operation));
});
