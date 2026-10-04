import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferenceLaunchPlan } from './inference-launch.ts';
const input = { runId: 'demo', actorIds: [15, 14, 13, 12, 11], provider: 'codex', model: 'gpt-6-astra', mode: 'production' as const, maxCalls: 0, orchestratorMaxCalls: 0, runMs: 60000 };
test('five physical actors map to low-effort workers and one high-effort orchestrator', () => {
  const plan = inferenceLaunchPlan(input);
  assert.equal(plan.totalCallLimit, null);
  assert.deepEqual(plan.workers.map(w => w.actorId), [11, 12, 13, 14, 15]);
  assert.deepEqual(plan.actorIds, [11, 12, 13, 14, 15]);
  assert.deepEqual(inferenceLaunchPlan({ ...input, actorIds: [...input.actorIds].reverse() }), plan);
  assert.equal(new Set(plan.workers.map(w => w.sender)).size, 5);
  assert.equal(new Set(plan.workers.map(w => w.taskId)).size, 5);
  assert.equal(plan.actorEffort, 'low');
  assert.deepEqual(plan.orchestrator, { sender: 'demo-orchestrator', model: 'gpt-6-astra', effort: 'high', maxCalls: null });
  assert.deepEqual(input.actorIds, [15, 14, 13, 12, 11]);
});
test('launcher rejects invalid providers and repeated actors while accepting unlimited calls', () => {
  assert.throws(() => inferenceLaunchPlan({ ...input, provider: 'rules' }));
  assert.throws(() => inferenceLaunchPlan({ ...input, actorIds: Array(5).fill(1) }));
  assert.throws(() => inferenceLaunchPlan({ ...input, model: 'gpt-6-astra-preview' }));
  assert.throws(() => inferenceLaunchPlan({ ...input, maxCalls: Infinity }));
  assert.throws(() => inferenceLaunchPlan({ ...input, runMs: 0 }));
  assert.throws(() => inferenceLaunchPlan({ ...input, runId: '../world' }));
});
test('smoke and production budgets are explicitly separated', () => {
  assert.equal(inferenceLaunchPlan({ ...input, mode: 'smoke', maxCalls: 3 }).mode, 'smoke');
  assert.throws(() => inferenceLaunchPlan({ ...input, mode: 'smoke', maxCalls: 4 }));
  assert.throws(() => inferenceLaunchPlan({ ...input, mode: 'production', maxCalls: 8, orchestratorMaxCalls: 10 }));
  assert.equal(inferenceLaunchPlan(input).totalCallLimit, null);
});
