import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlan } from './actions.ts';

test('accepts a short Factorio movement and mining sequence', () => {
  const plan = parsePlan(JSON.stringify({
    reason: 'Move toward visible ore and mine briefly', done: false,
    actions: [
      { type: 'key', key: 'w', durationMs: 300 },
      { type: 'hold_mouse', x: 520, y: 430, button: 'right', durationMs: 500 },
    ],
  }));
  assert.equal(plan.actions.length, 2);
});

test('rejects unsupported keys, out-of-window coordinates, and long holds', () => {
  for (const actions of [
    [{ type: 'key', key: 'command', durationMs: 100 }],
    [{ type: 'key', key: 'return', durationMs: 100 }],
    [{ type: 'click', x: 1001, y: 500, button: 'left', durationMs: 100 }],
    [{ type: 'key', key: 'w', durationMs: 601 }],
  ]) {
    assert.throws(() => parsePlan(JSON.stringify({ reason: 'invalid', done: false, actions })));
  }
});

test('rejects extra commands and actions after completion', () => {
  assert.throws(() => parsePlan(JSON.stringify({
    reason: 'try shell', done: false, actions: [{ type: 'shell', command: 'whoami' }],
  })));
  assert.throws(() => parsePlan(JSON.stringify({
    reason: 'complete', done: true, actions: [{ type: 'key', key: 'e', durationMs: 100 }],
  })));
});

test('accepts bounded Minecraft camera and movement actions', () => {
  const plan = parsePlan(JSON.stringify({
    reason: 'Turn toward the tree, then approach it', done: false,
    actions: [
      { type: 'look', dx: 35, dy: -12, durationMs: 120 },
      { type: 'keys', keys: ['w', 'space'], durationMs: 250 },
    ],
  }), 'minecraft');
  assert.equal(plan.actions[0]?.type, 'look');
});

test('rejects unsafe camera deltas, duplicate keys, and Minecraft actions in Factorio', () => {
  for (const actions of [
    [{ type: 'look', dx: 121, dy: 0, durationMs: 100 }],
    [{ type: 'look', dx: 0, dy: 0, durationMs: 100 }],
    [{ type: 'keys', keys: ['w', 'w'], durationMs: 100 }],
  ]) {
    assert.throws(() => parsePlan(JSON.stringify({ reason: 'invalid', done: false, actions }), 'minecraft'));
  }
  assert.throws(() => parsePlan(JSON.stringify({ reason: 'invalid', done: false,
    actions: [{ type: 'look', dx: 10, dy: 0, durationMs: 100 }] }), 'factorio'));
});
