import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ask } from '../agents/llm.ts';
import type { BoardSnapshot } from '../../message-board/client.ts';
import { runInferenceWorker, validateObservation, type InferenceState, type InferenceWorkerOptions } from './inference-worker.ts';
import { encodeOperation } from './protocol.ts';
const scope = { runId: 'run', worldId: 'world', historyId: 'history', actorId: 7, sender: 'run-agent-1' };
function fixture() {
  const state: InferenceState = { version: 1, scope, calls: 0, tick: 0, lastResult: null, pending: null, decision: null };
  const events: { kind: string; payload: unknown }[] = [];
  const task = { id: 'task', status: 'claimed', assignee: scope.sender };
  const observation = { actorId: 7, tick: 100, x: 0, y: 0, world: { worldId: 'world', historyId: 'history' }, paused: false, inventory: { ironPlate: 5 }, nearby: [] };
  const board = { ready: true, snapshot: () => ({ tasks: [task], messages: [], reservations: [], participants: [] }) as unknown as BoardSnapshot,
    register: async () => {}, post: async (_sender: string, body: string) => { events.push(JSON.parse(body)); }, claimTask: async () => {},
    updateTask: async (_name: string, _id: string, status: string) => { task.status = status; }, reserve: async () => {}, releaseReservation: async () => {} };
  const saves: InferenceState[] = [];
  let mutations = 0;
  const options: InferenceWorkerOptions = { scope, taskId: 'task', objective: 'Five plates', operatorPrompt: () => 'Communicate', maxCalls: 2,
    deadline: Date.now() + 5000, timeoutMs: 1000, requiredPlates: 5, state, board,
    save: s => saves.push(JSON.parse(JSON.stringify(s))), sleep: async () => {},
    game: request => { if (request.kind === 'execute') mutations++; return observation; },
    ask: (async () => ({ kind: 'complete', command: null, message: 'Five plates observed', recipient: '', waitMs: 0 })) as Ask };
  return { options, task, observation, events, saves, mutations: () => mutations };
}
test('model completion is verified and call charged before dispatch', async () => {
  const f = fixture();
  f.options.ask = (async () => {
    assert.equal(f.saves.at(-1)?.calls, 1);
    return { kind: 'complete', command: null, message: 'Verified', recipient: '', waitMs: 0 };
  }) as Ask;
  await runInferenceWorker(f.options);
  assert.equal(f.task.status, 'done'); assert.equal(f.mutations(), 0);
  assert.deepEqual(f.events.map(e => e.kind), ['decision', 'completion']);
});
test('false completion consumes budget and never completes the task', async () => {
  const f = fixture(); f.observation.inventory.ironPlate = 0;
  await assert.rejects(runInferenceWorker(f.options), /budget exhausted/);
  assert.equal(f.task.status, 'claimed'); assert.equal(f.options.state.calls, 2);
});
test('task cancellation during model call prevents execution', async () => {
  const f = fixture();
  f.options.ask = (async () => { f.task.status = 'cancelled'; return { kind: 'action', command: { kind: 'move', x: 1, y: 1, maxTicks: 10 }, message: 'Move', recipient: '', waitMs: 0 }; }) as Ask;
  await assert.rejects(runInferenceWorker(f.options), /ownership lost/);
  assert.equal(f.mutations(), 0);
});
test('peer chat is posted and becomes a new inference turn', async () => {
  const f = fixture(); let calls = 0;
  f.options.ask = (async () => ++calls === 1 ? { kind: 'chat', command: null, message: 'Furnace free', recipient: 'run-agent-2', waitMs: 0 } :
    { kind: 'complete', command: null, message: 'Done', recipient: '', waitMs: 0 }) as Ask;
  await runInferenceWorker(f.options);
  assert.equal(f.events.filter(e => e.kind === 'chat').length, 1); assert.equal(calls, 2);
});
test('recovered unknown game outcome is quarantined rather than replayed', async () => {
  const f = fixture(); f.options.state.pending = { id: 'pending', command: { kind: 'move', x: 0, y: 0, maxTicks: 10 }, digest: 'a'.repeat(64) };
  await assert.rejects(runInferenceWorker(f.options), /Unknown game outcome/);
  assert.equal(f.mutations(), 0); assert.equal(f.options.state.calls, 0);
});
test('game observation rejects other actors, worlds and tick rollback', () => {
  const f = fixture();
  assert.throws(() => validateObservation({ ...f.observation, actorId: 8 }, scope, 0));
  assert.throws(() => validateObservation({ ...f.observation, world: { worldId: 'other', historyId: 'history' } }, scope, 0));
  assert.throws(() => validateObservation(f.observation, scope, 101));
});
test('action intent is saved before game mutation and receipt is published', async () => {
  const f = fixture(); let calls = 0;
  const command = { kind: 'move' as const, x: 1, y: 0, maxTicks: 10 };
  f.options.ask = (async () => ++calls === 1 ? { kind: 'action', command, message: 'Approach furnace', recipient: '', waitMs: 0 } :
    { kind: 'complete', command: null, message: 'Done', recipient: '', waitMs: 0 }) as Ask;
  f.options.game = request => {
    if (request.kind !== 'execute') return f.observation;
    const pending = f.saves.at(-1)?.pending;
    assert.ok(pending); assert.equal(pending.id, request.operation);
    const { digest } = encodeOperation({ version: 1, worldId: 'world', historyId: 'history', actorId: 7, operationId: pending.id, command });
    return { version: 1, operationId: pending.id, digest, worldId: 'world', historyId: 'history', actorId: 7, status: 'completed', startTick: 100, endTick: 100 };
  };
  await runInferenceWorker(f.options);
  assert.equal(f.options.state.pending, null);
  assert.equal(f.events.filter(e => e.kind === 'action_result').length, 1);
});
test('pause applied during inference prevents a proposed mutation', async () => {
  const f = fixture();
  f.options.ask = (async () => { f.observation.paused = true; return { kind: 'action', command: { kind: 'move', x: 1, y: 0, maxTicks: 10 }, message: 'Move', recipient: '', waitMs: 0 }; }) as Ask;
  f.options.sleep = async () => { if (f.observation.paused) f.task.status = 'cancelled'; };
  await assert.rejects(runInferenceWorker(f.options), /ownership lost/);
  assert.equal(f.mutations(), 0);
});
