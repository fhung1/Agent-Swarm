import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferenceLaunchPlan } from './inference-launch.ts';
const input = { runId: 'demo', actorIds: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1], provider: 'codex', model: 'configured-model', maxCalls: 4, runMs: 60000 };
test('ten physical actors map deterministically to ten independent identities/tasks', () => {
  const plan = inferenceLaunchPlan(input);
  assert.equal(plan.totalCallLimit, 40);
  assert.deepEqual(plan.workers.map(w => w.actorId), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(plan.actorIds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(inferenceLaunchPlan({ ...input, actorIds: [...input.actorIds].reverse() }), plan);
  assert.equal(new Set(plan.workers.map(w => w.sender)).size, 10);
  assert.equal(new Set(plan.workers.map(w => w.taskId)).size, 10);
  assert.deepEqual(input.actorIds, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});
test('launcher rejects rules fallback, repeated actors and unbounded calls', () => {
  assert.throws(() => inferenceLaunchPlan({ ...input, provider: 'rules' }));
  assert.throws(() => inferenceLaunchPlan({ ...input, actorIds: Array(10).fill(1) }));
  assert.throws(() => inferenceLaunchPlan({ ...input, maxCalls: Infinity }));
  assert.throws(() => inferenceLaunchPlan({ ...input, runMs: 0 }));
  assert.throws(() => inferenceLaunchPlan({ ...input, runId: '../world' }));
});
