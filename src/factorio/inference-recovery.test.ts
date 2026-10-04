import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferenceFailureExitCode, runInferenceWorker, type InferenceWorkerOptions } from './inference-worker.ts';

function fixture(pending = false) {
  const scope = { runId: 'recovery', worldId: 'world', historyId: 'history', actorId: 12, sender: 'recovery-agent-1' };
  const taskId = 'recovery.subtask-orchestrator-1';
  const tasks = Array.from({ length: 5 }, (_, i) => ({ id: `recovery.subtask-orchestrator-${i + 1}`, title: 'Fuel miner', details: '', area: 'factorio-orchestration', status: 'claimed', assignee: `recovery-agent-${i + 1}` }));
  const messages = tasks.map((t, i) => ({ sender: 'recovery-orchestrator', recipient: t.assignee, body: JSON.stringify({ runId: scope.runId, kind: 'orchestrator_task', payload: { taskId: t.id } }), id: BigInt(i) }));
  const reservations = [{ path: 'world/world/entity/247', holder: scope.sender, taskId, expiresAt: { microsSinceUnixEpoch: 0n } }];
  let renewals = 0, calls = 0, mutations = 0, receipts = 0;
  const options: InferenceWorkerOptions = {
    scope, taskId, objective: 'Fuel miner', operatorPrompt: () => '', maxCalls: 1, deadline: Date.now() + 2000,
    timeoutMs: 500, requiredPlates: 0,
    state: { version: 1, scope, calls: 0, tick: 0, lastResult: null, decision: null,
      pending: pending ? { id: 'transfer', digest: 'a'.repeat(64), command: { kind: 'put', targetId: 247, item: 'coal', quantity: 5 } } : null },
    save: () => {},
    board: { ready: true, snapshot: () => ({ tasks, messages, reservations, participants: [] }) as any,
      register: async () => {}, post: async () => {}, createTask: async () => {}, claimTask: async () => {},
      updateTask: async () => {}, reserve: async () => { renewals++; }, releaseReservation: async () => {} },
    game: request => {
      if (request.kind === 'execute') mutations++;
      if (request.kind === 'receipt') { receipts++; return null; }
      if (request.kind === 'status') return { automation: { verified: true } };
      return { actorId: 12, tick: 100, x: 0, y: 0, world: scope, paused: false, inventory: {}, nearby: [] };
    },
    ask: (async () => { calls++; return { kind: 'complete', command: null, message: 'Verified', recipient: '', waitMs: 0 }; }) as any,
  };
  return { options, counts: () => ({ renewals, calls, mutations, receipts }) };
}
test('restart ignores expired own leases without renewing or replaying transfers', async () => {
  const f = fixture();
  await runInferenceWorker(f.options);
  assert.deepEqual(f.counts(), { renewals: 0, calls: 1, mutations: 0, receipts: 0 });
});
test('expired lease does not bypass reconciliation of an unknown transfer', async () => {
  const f = fixture(true);
  await assert.rejects(runInferenceWorker(f.options), /Unknown game outcome/);
  assert.deepEqual(f.counts(), { renewals: 0, calls: 0, mutations: 0, receipts: 1 });
  assert.equal(f.options.state.pending?.id, 'transfer');
});

test('restart resolves a completed transfer before inference and never resubmits it', async () => {
  const f = fixture(true);
  const game = f.options.game;
  const pending = f.options.state.pending!;
  f.options.game = request => request.kind === 'receipt' ? {
    version: 1, operationId: pending.id, digest: pending.digest, ...f.options.scope,
    status: 'completed', startTick: 90, endTick: 95, quantity: 5, item: 'coal', targetId: 247,
  } : game(request);
  await runInferenceWorker(f.options);
  assert.equal(f.options.state.pending, null);
  assert.equal(f.counts().mutations, 0);
  assert.equal(f.counts().renewals, 0);
  assert.equal(f.counts().calls, 1);
});


test('only reconcilable transport failures retry; unknown outcomes quarantine', async () => {
  const {ResourceRenewalUncertain} = await import('./resource-leases.ts');
  assert.equal(inferenceFailureExitCode(new ResourceRenewalUncertain('renewal uncertain')), 75);
  assert.equal(inferenceFailureExitCode(new Error('Board disconnected')), 75);
  assert.equal(inferenceFailureExitCode(new Error('Unknown game outcome: transfer')), 78);
  assert.equal(inferenceFailureExitCode(new Error('Resource lease lost')), 1);
});

test('lease heartbeats continue during asynchronous game reads', async () => {
  const f=fixture(); let renewals=0;
  const reservation={path:'world/world/entity/247',holder:f.options.scope.sender,taskId:f.options.taskId,
    expiresAt:{microsSinceUnixEpoch:BigInt(Date.now()+1000)*1000n}};
  const snapshot=f.options.board.snapshot;
  f.options.board.snapshot=()=>({...snapshot(),reservations:[reservation]}) as any;
  f.options.board.reserve=async()=>{renewals++;reservation.expiresAt.microsSinceUnixEpoch=BigInt(Date.now()+1000)*1000n;};
  f.options.leaseRenewalMs=10;
  const game=f.options.game;
  f.options.game=async request=>{
    await new Promise(resolve=>setTimeout(resolve,80));
    return game(request);
  };
  await runInferenceWorker(f.options);
  assert.ok(renewals>=3);
  const count=renewals;
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(renewals,count);
});
