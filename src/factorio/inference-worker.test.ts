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
  f.options.ask = (async (_schema, _system, prompt) => {
    assert.equal(f.saves.at(-1)?.calls, 1);
    const budget = JSON.parse(prompt).budget;
    assert.equal(budget.remainingCalls, 1); assert.ok(budget.remainingMs > 0);
    return { kind: 'complete', command: null, message: 'Verified', recipient: '', waitMs: 0 };
  }) as Ask;
  await runInferenceWorker(f.options);
  assert.equal(f.task.status, 'done'); assert.equal(f.mutations(), 0);
  assert.deepEqual(f.events.map(e => e.kind), ['inference_audit', 'decision', 'completion']);
  assert.equal((f.events[0]!.payload as { usageKnown: boolean }).usageKnown, false);
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
test('completed task restart checks real inventory before accepting completion', async () => {
  const f = fixture(); f.task.status = 'done'; f.observation.inventory.ironPlate = 0;
  await assert.rejects(runInferenceWorker(f.options), /disagrees with live actor/);
  assert.equal(f.options.state.calls, 0);
});
test('losing a resource reservation race becomes model feedback, not a mutation', async () => {
  const f = fixture(); f.options.maxCalls = 1;
  f.options.game = () => ({ ...f.observation, nearby: [{ unit: 42, type: 'container', x: 1, y: 0 }] });
  f.options.ask = (async () => ({ kind: 'action', command: { kind: 'take', targetId: 42, item: 'iron-ore', quantity: 5 }, message: 'Take ore', recipient: '', waitMs: 0 })) as Ask;
  f.options.board.reserve = async () => { throw Error('Peer won reservation'); };
  await assert.rejects(runInferenceWorker(f.options), /budget exhausted/);
  assert.match(JSON.stringify(f.options.state.lastResult), /reservation refused/);
  assert.equal(f.options.state.pending, null);
});
test('known game rejection is published as feedback and the next model turn can recover', async () => {
  const f = fixture(); let calls = 0;
  const command = { kind: 'move' as const, x: 100, y: 0, maxTicks: 10 };
  f.options.ask = (async (_schema, _system, prompt) => {
    if (++calls === 1) return { kind: 'action', command, message: 'Move', recipient: '', waitMs: 0 };
    assert.equal(JSON.parse(prompt).lastResult.status, 'failed');
    assert.match(JSON.parse(prompt).lastResult.detail, /outside local radius/);
    assert.equal(f.options.state.pending, null);
    return { kind: 'complete', command: null, message: 'Inventory already satisfies goal', recipient: '', waitMs: 0 };
  }) as Ask;
  f.options.game = request => {
    if (request.kind === 'execute') throw Error('Bridge reports failed admission');
    if (request.kind !== 'receipt') return f.observation;
    const pending = f.options.state.pending!;
    return { version: 1, operationId: pending.id, digest: pending.digest, worldId: scope.worldId,
      historyId: scope.historyId, actorId: scope.actorId, status: 'failed', startTick: 100, endTick: 100,
      detail: 'Movement outside local radius' };
  };
  await runInferenceWorker(f.options);
  assert.equal(calls, 2); assert.equal(f.task.status, 'done');
  assert.equal(f.events.filter(e => e.kind === 'action_result').length, 1);
});
test('restart reconciles a rejected operation without resubmitting it', async () => {
  const f = fixture();
  f.options.state.pending = { id: 'rejected', command: { kind: 'move', x: 100, y: 0, maxTicks: 10 }, digest: 'a'.repeat(64) };
  f.options.game = request => {
    assert.notEqual(request.kind, 'execute');
    return request.kind === 'receipt' ? { version: 1, operationId: 'rejected', digest: 'a'.repeat(64),
      worldId: scope.worldId, historyId: scope.historyId, actorId: scope.actorId,
      status: 'failed', startTick: 100, endTick: 100, detail: 'Movement outside local radius' } : f.observation;
  };
  await runInferenceWorker(f.options);
  assert.equal(f.options.state.pending, null); assert.equal(f.task.status, 'done');
});
test('retained furnace lease renews throughout a long model call and stops after completion', async () => {
  const f = fixture(); let renewals = 0;
  const path = 'world/world/entity/42';
  const reservation = { path, holder: scope.sender, taskId: 'task',
    expiresAt: { microsSinceUnixEpoch: BigInt(Date.now() + 120) * 1000n } };
  const snapshot = f.options.board.snapshot;
  f.options.board.snapshot = () => ({ ...snapshot(), reservations: [reservation] }) as unknown as BoardSnapshot;
  f.options.board.reserve = async () => {
    assert.ok(reservation.expiresAt.microsSinceUnixEpoch > BigInt(Date.now()) * 1000n);
    renewals++; reservation.expiresAt.microsSinceUnixEpoch = BigInt(Date.now() + 120) * 1000n;
  };
  f.options.leaseRenewalMs = 10;
  f.options.ask = (async () => {
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(renewals >= 3, 'resource renewed independently of the pending model call');
    return { kind: 'complete', command: null, message: 'Done', recipient: '', waitMs: 0 };
  }) as Ask;
  await runInferenceWorker(f.options);
  const count = renewals; await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(renewals, count); assert.equal(f.task.status, 'done');
});
test('peer takeover during inference cancels the model and never renews the peer resource', async () => {
  const f = fixture(); let renewals = 0;
  const reservation = { path: 'world/world/entity/42', holder: scope.sender, taskId: 'task',
    expiresAt: { microsSinceUnixEpoch: BigInt(Date.now() + 1000) * 1000n } };
  const snapshot = f.options.board.snapshot;
  f.options.board.snapshot = () => ({ ...snapshot(), reservations: [reservation] }) as unknown as BoardSnapshot;
  f.options.board.reserve = async () => { assert.equal(reservation.holder, scope.sender); renewals++; };
  f.options.leaseRenewalMs = 10;
  f.options.ask = (async () => {
    reservation.holder = 'peer';
    return await new Promise(() => {});
  }) as Ask;
  await assert.rejects(runInferenceWorker(f.options), /Resource lease lost/);
  assert.equal(renewals, 1); assert.equal(f.mutations(), 0); assert.equal(f.options.state.pending, null);
});
test('expired peer reservations are omitted from context and do not prevent atomic acquisition', async () => {
  const f = fixture(); let calls = 0; let acquisitions = 0;
  const command = { kind: 'take' as const, targetId: 42, item: 'iron-ore' as const, quantity: 5 };
  let reservations = [{ path: 'world/world/entity/42', holder: 'peer', taskId: 'peer-task',
    expiresAt: { microsSinceUnixEpoch: 0n } }];
  const snapshot = f.options.board.snapshot;
  f.options.board.snapshot = () => ({ ...snapshot(), reservations }) as unknown as BoardSnapshot;
  f.options.board.reserve = async () => {
    acquisitions++;
    reservations = [{ ...reservations[0], holder: scope.sender, taskId: 'task',
      expiresAt: { microsSinceUnixEpoch: BigInt(Date.now() + 60_000) * 1000n } }];
  };
  f.options.board.releaseReservation = async () => { reservations = []; };
  f.options.ask = (async (_schema, _system, prompt) => {
    if (++calls === 1) {
      assert.deepEqual(JSON.parse(prompt).reservations, []);
      return { kind: 'action', command, message: 'Acquire the expired resource', recipient: '', waitMs: 0 };
    }
    return { kind: 'complete', command: null, message: 'Done', recipient: '', waitMs: 0 };
  }) as Ask;
  f.options.game = request => {
    if (request.kind !== 'execute') return { ...f.observation, nearby: [{ unit: 42, type: 'container', x: 1, y: 0 }] };
    const pending = f.options.state.pending!;
    return { version: 1, operationId: pending.id, digest: pending.digest,
      worldId: scope.worldId, historyId: scope.historyId, actorId: scope.actorId,
      status: 'completed', startTick: 100, endTick: 100, quantity: 5 };
  };
  await runInferenceWorker(f.options);
  assert.equal(acquisitions, 1); assert.equal(f.task.status, 'done');
});
test('paused workers retain resource leases without dispatching model calls', async () => {
  const f = fixture(); let renewals = 0; let calls = 0;
  f.observation.paused = true;
  const reservation = { path: 'world/world/entity/42', holder: scope.sender, taskId: 'task',
    expiresAt: { microsSinceUnixEpoch: BigInt(Date.now() + 1000) * 1000n } };
  const snapshot = f.options.board.snapshot;
  f.options.board.snapshot = () => ({ ...snapshot(), reservations: [reservation] }) as unknown as BoardSnapshot;
  f.options.board.reserve = async () => { assert.equal(calls, 0); renewals++; };
  f.options.leaseRenewalMs = 10;
  f.options.sleep = async () => {
    await new Promise(resolve => setTimeout(resolve, 15));
    if (renewals >= 3) f.observation.paused = false;
  };
  f.options.ask = (async () => {
    assert.equal(f.observation.paused, false); calls++;
    return { kind: 'complete', command: null, message: 'Done', recipient: '', waitMs: 0 };
  }) as Ask;
  await runInferenceWorker(f.options);
  assert.ok(renewals >= 3); assert.equal(calls, 1); assert.equal(f.task.status, 'done');
});
