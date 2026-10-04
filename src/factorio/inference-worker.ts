import { deadlineFromDuration, runExpired, remainingRunMs } from './run-duration.ts';
import { repeatsLatestChat } from './communication.ts';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { MessageBoardClient, type BoardSnapshot } from '../../message-board/client.ts';
import { createAsker, type Ask } from '../agents/llm.ts';
import { decideFactorio, InvalidFactorioDecisionError, selectPeerMessages, type FactorioScope, type FactorioDecision } from './inference.ts';
import { encodeOperation, type Command, type Receipt } from './protocol.ts';
import { ResourceLeases, ResourceRenewalUncertain } from './resource-leases.ts';
import { createFactorioSpendGuard, type FactorioSpendGuard } from './run-spend.ts';
import { isTransientTransportFailure, RETRYABLE_TRANSPORT_FAILURE } from './transient-errors.ts';

export interface Observation {
  actorId: number; tick: number; x: number; y: number; world: { worldId: string; historyId: string }; paused: boolean;
  inventory: { ironPlate?: number; items?: Record<string, number> };
  nearby: { unit: number; name?: string; type: string; x: number; y: number; amount?: number; items?: { items?: Record<string, number> } }[];
  terrain?: { area: number[][]; waterTiles: number; landTiles: number; unknownTiles: number;
    nearestWater?: {x:number;y:number;name:string}; shorelines: {waterX:number;waterY:number;landX:number;landY:number;waterTile:string}[];
    omittedShorelines: number; note: string };
}
export interface InferenceState {
  version: 1; scope: FactorioScope; calls: number; tick: number; lastResult: unknown;
  pending: { id: string; command: Command; digest: string } | null;
  decision: { id: string; output: FactorioDecision } | null;
}
type WorkerBoard = Pick<MessageBoardClient, 'ready' | 'snapshot' | 'register' | 'post' | 'createTask' | 'claimTask' | 'updateTask' | 'reserve' | 'releaseReservation'>;
export interface InferenceWorkerOptions {
  scope: FactorioScope; taskId: string; objective: string; operatorPrompt: () => string;
  maxCalls: number; deadline: number; timeoutMs: number; requiredPlates: number; goal?: 'plates' | 'rocket';
  ask: Ask; board: WorkerBoard; game: (request: Record<string, unknown>) => unknown;
  state: InferenceState; save: (state: InferenceState) => void; sleep?: (ms: number) => Promise<void>;
  spend?: FactorioSpendGuard;
  signal?: AbortSignal; leaseRenewalMs?: number;
}

export function validateObservation(value: unknown, scope: FactorioScope, minimumTick: number): Observation {
  const o = value as Observation;
  if (o && o.nearby && !Array.isArray(o.nearby) && typeof o.nearby === 'object' && Object.keys(o.nearby).length === 0) o.nearby = [];
  if (!o || o.actorId !== scope.actorId || o.world?.worldId !== scope.worldId || o.world?.historyId !== scope.historyId ||
    !Number.isSafeInteger(o.tick) || o.tick < minimumTick || !Number.isFinite(o.x) || !Number.isFinite(o.y) ||
    typeof o.paused !== 'boolean' || !o.inventory || !Array.isArray(o.nearby)) throw Error('Foreign, stale or invalid game observation');
  return o;
}
export function assertTaskOwnership(snapshot: BoardSnapshot, taskId: string, sender: string): void {
  const task = snapshot.tasks.find(t => t.id === taskId);
  if (!task || task.status !== 'claimed' || task.assignee !== sender) throw Error('Task ownership lost');
}
/** Only a scoped, directed coordinator announcement can change an actor's assignment. */
export function latestActorAssignment(snapshot: BoardSnapshot, scope: FactorioScope, anchorTaskId: string): BoardSnapshot['tasks'][number] | undefined {
  const coordinator = `${scope.runId}-orchestrator`;
  const announcements = snapshot.messages.filter(row => row.sender === coordinator && row.recipient === scope.sender)
    .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0);
  for (const row of announcements) {
    let body: Record<string, any>;
    try { body = JSON.parse(row.body); } catch { continue; }
    if (body.version !== 1 || body.sender !== coordinator || body.runId !== scope.runId ||
      body.worldId !== scope.worldId || body.historyId !== scope.historyId || body.kind !== 'orchestrator_task') continue;
    const taskId = body.payload?.taskId;
    if (typeof taskId !== 'string' || taskId === anchorTaskId || !taskId.startsWith(`${scope.runId}.subtask-orchestrator-`)) continue;
    const task = snapshot.tasks.find(t => t.id === taskId && t.area === 'factorio-orchestration' &&
      (t.status === 'open' || (t.status === 'claimed' && t.assignee === scope.sender)));
    if (task) return task;
  }
  return undefined;
}
function checkReceipt(value: unknown, pending: NonNullable<InferenceState['pending']>, scope: FactorioScope, tick: number): Receipt {
  const r = value as Receipt;
  if (!r || r.operationId !== pending.id || r.digest !== pending.digest || r.worldId !== scope.worldId ||
    r.historyId !== scope.historyId || r.actorId !== scope.actorId || !['completed', 'failed'].includes(r.status) ||
    !Number.isSafeInteger(r.endTick) || r.endTick! < tick) throw Error('Unknown game outcome: quarantine, never replay');
  return r;
}

/** One process/identity per actor. Every model call is charged before dispatch and every
 * mutation is journaled before submission. Recovered missing receipts stop the worker. */
export async function runInferenceWorker(o: InferenceWorkerOptions): Promise<void> {
  const { board, scope, state } = o;
  if (!Number.isSafeInteger(o.maxCalls) || o.maxCalls < 0 || o.maxCalls > 1000 || !Number.isSafeInteger(o.requiredPlates) || o.requiredPlates < 0 || (!Number.isSafeInteger(o.deadline) || o.deadline < 0)) throw Error('Invalid worker limits');
  if (state.version !== 1 || JSON.stringify(state.scope) !== JSON.stringify(scope) || !Number.isSafeInteger(state.calls) || state.calls < 0 || !Number.isSafeInteger(state.tick) || state.tick < 0) throw Error('Foreign or corrupt inference journal');
  const sleep = o.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const leaseController = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, leaseController.signal]) : leaseController.signal;
  const withinRun = () => { signal.throwIfAborted(); if (runExpired(o.deadline)) throw Error('Run deadline reached'); };
  const waitReady = async () => { while (!board.ready) { withinRun(); await sleep(250); } };
  const snapshot = () => { if (!board.ready) throw Error('Board disconnected'); const s = board.snapshot(); assertTaskOwnership(s, o.taskId, scope.sender); return s; };
  let lastTaskLabel = '';
  const publishTaskLabel = async (active: BoardSnapshot['tasks'][number] | undefined) => {
    let label = '';
    for (const character of Array.from((active?.title ?? 'Waiting for task').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim())) {
      if (Buffer.byteLength(label + character, 'utf8') > 72) break;
      label += character;
    }
    label ||= 'Waiting for task';
    if (label !== lastTaskLabel) { await o.game({ kind: 'task_label', actor: scope.actorId, label }); lastTaskLabel = label; }
  };
  const observe = async () => {
    const observed = validateObservation(await o.game({ kind: 'observe', actor: scope.actorId }), scope, state.tick);
    state.tick = observed.tick; o.save(state); return observed;
  };
  const reconcileReceipt = async (pending: NonNullable<InferenceState['pending']>, submittedTick: number, first?: unknown): Promise<Receipt> => {
    let response = first, polls = 0;
    let deadlineTick = submittedTick + (pending.command.kind === 'move' ? pending.command.maxTicks + 120 : 120);
    let lastTick = -1, lastProgressAt = Date.now();
    while (true) {
      withinRun(); await waitReady(); snapshot();
      let observed = await observe();
      if (observed.tick !== lastTick) { lastTick = observed.tick; lastProgressAt = Date.now(); }
      if (response === undefined) response = await o.game({ kind: 'receipt', operation: pending.id });
      if (response !== null && response !== undefined) {
        const r = response as Receipt & { deadline?: number };
        if (r.operationId !== pending.id || r.digest !== pending.digest || r.worldId !== scope.worldId ||
            r.historyId !== scope.historyId || r.actorId !== scope.actorId) throw Error('Unknown game outcome: foreign receipt');
        if (r.status === 'completed' || r.status === 'failed') {
          const final = checkReceipt(r, pending, scope, submittedTick);
          if (final.endTick! > observed.tick) observed = await observe();
          if (final.endTick! > observed.tick) throw Error('Receipt from future history');
          return final;
        }
        if (r.status !== 'pending' || pending.command.kind !== 'move' || !Number.isSafeInteger(r.startTick) ||
            r.startTick < submittedTick || !Number.isSafeInteger(r.deadline) || r.deadline! < r.startTick ||
            r.deadline! > r.startTick + pending.command.maxTicks) throw Error('Unknown game outcome: invalid pending receipt');
        deadlineTick = r.deadline! + 120;
      }
      polls++;
      if ((pending.command.kind !== 'move' && polls >= 3) || observed.tick > deadlineTick ||
          (!observed.paused && Date.now() - lastProgressAt > 30_000)) throw Error('Unknown game outcome: no final receipt after bounded reconciliation');
      response = undefined;
      await sleep(250);
    }
  };
  const post = async (id: string, kind: string, payload: unknown, recipient = '') => {
    const s = snapshot();
    if (s.messages.some(m => { try { const e = JSON.parse(m.body); return m.sender === scope.sender && e.runId === scope.runId && e.worldId === scope.worldId && e.historyId === scope.historyId && e.eventId === id; } catch { return false; } })) return;
    await board.post(scope.sender, JSON.stringify({ version: 1, ...scope, taskId: o.taskId, eventId: id, kind, payload }), recipient, o.taskId);
  };
  const leases = new ResourceLeases({ sender: scope.sender, taskId: o.taskId,
    snapshot: () => board.snapshot().reservations, validate: () => { withinRun(); snapshot(); },
    renew: path => board.reserve(scope.sender, path, o.taskId, 'Inference actor resource lease', 1),
    onLost: error => leaseController.abort(error), intervalMs: o.leaseRenewalMs });
  try {
    await waitReady();
    await board.register(scope.sender, 'inference-worker', `actor ${scope.actorId}; run ${scope.runId}`);
    let initial: ReturnType<typeof board.snapshot>['tasks'][number] | null = null;
    while (!initial) {
      withinRun(); await waitReady();
      const current = board.snapshot();
      const candidate = current.tasks.find(t => t.id === o.taskId);
      const announced = current.messages.some(row => {
        if (row.sender !== `${scope.runId}-orchestrator` || row.recipient !== scope.sender) return false;
        try {
          const body = JSON.parse(row.body);
          return body.runId === scope.runId && body.kind === 'orchestrator_task' && body.payload?.taskId === o.taskId;
        } catch { return false; }
      });
      const allActorsAssigned = Array.from({ length: 5 }, (_, index) => {
        const actor = `${scope.runId}-agent-${index + 1}`, taskId = `${scope.runId}.subtask-orchestrator-${index + 1}`;
        const taskExists = current.tasks.some(task => task.id === taskId && task.area === 'factorio-orchestration');
        const messageExists = current.messages.some(row => {
          if (row.sender !== `${scope.runId}-orchestrator` || row.recipient !== actor) return false;
          try {
            const body = JSON.parse(row.body);
            return body.runId === scope.runId && body.kind === 'orchestrator_task' && body.payload?.taskId === taskId;
          } catch { return false; }
        });
        return taskExists && messageExists;
      }).every(Boolean);
      if (candidate && announced && allActorsAssigned) { initial = candidate; break; }
      await sleep(100);
    }
    const assignedObjective = [initial.title, initial.details].filter(Boolean).join('\n');
    if (initial.status === 'done' && initial.assignee === scope.sender) {
      await observe();
      const engineStatus = await o.game({ kind: 'status' }) as { rocketLaunches?: number; furnaces?: number; automation?: { verified: boolean } };
      const won = o.goal === 'rocket' ? Number(engineStatus.rocketLaunches) >= 1
        : engineStatus.automation?.verified === true;
      if (state.pending || !won) throw Error('Completed task disagrees with live actor state');
      return;
    }
    if (initial.status === 'open') await board.claimTask(scope.sender, o.taskId);
    // Reducer completion precedes local subscription callbacks.
    for (let i = 0; i < 40; i++) {
      if (board.snapshot().tasks.some(t => t.id === o.taskId && t.status === 'claimed' && t.assignee === scope.sender)) break;
      withinRun(); await sleep(100);
    }
    snapshot();
    await publishTaskLabel(initial);
    if (state.pending) {
      const receipt = await reconcileReceipt(state.pending, state.tick);
      state.lastResult = receipt; state.pending = null; state.decision = null; o.save(state);
      await post(receipt.operationId, 'action_result', receipt);
    }
    // Retry an uncertain board publication from saved game evidence after reconnect/restart.
    const previousReceipt = state.lastResult as Receipt | null;
    if (previousReceipt?.operationId && previousReceipt.worldId === scope.worldId && previousReceipt.historyId === scope.historyId && previousReceipt.actorId === scope.actorId) {
      await post(previousReceipt.operationId, 'action_result', previousReceipt);
    }
    // Reconcile uncertain game outcomes before restoring any resource ownership.
    // Expired rows are history, not leases: new actions acquire them atomically.
    for (const reservation of board.snapshot().reservations.filter(r => r.holder === scope.sender &&
      r.taskId === o.taskId && r.path.startsWith(`world/${scope.worldId}/`) &&
      r.expiresAt.microsSinceUnixEpoch > BigInt(Date.now()) * 1000n)) leases.track(reservation.path);
    leases.start();
    while (true) {
      withinRun(); await waitReady();
      const boardState = snapshot();
      const assignment = latestActorAssignment(boardState, scope, o.taskId);
      if (assignment?.status === 'open') await board.claimTask(scope.sender, assignment.id);
      await publishTaskLabel(assignment ?? boardState.tasks.find(t => t.id === o.taskId));
      let observed = await observe();
      if (observed.paused) { await sleep(500); continue; }
      await leases.refresh();
      if (!state.decision) {
        if (o.maxCalls > 0 && state.calls >= o.maxCalls) throw Error('Inference call budget exhausted');
        state.calls++; o.save(state);
        const id = `${scope.runId}-${scope.sender}-infer-${state.calls}`;
        const currentObjective = assignment ? [assignment.title, assignment.details].filter(Boolean).join('\n')
          : o.goal === 'rocket' ? o.objective : assignedObjective || o.objective;
        const context = { ...scope, objective: currentObjective, operatorPrompt: o.operatorPrompt(), observation: observed,
          status: await o.game({ kind: 'status' }), reservations: board.snapshot().reservations
            .filter(r => r.expiresAt.microsSinceUnixEpoch > BigInt(Date.now()) * 1000n)
            .map(r => ({ path: r.path, holder: r.holder })),
          tasks: board.snapshot().tasks.filter(t => t.id.startsWith(`${scope.runId}.`)).slice(0, 40).map(t => ({ id: t.id, title: t.title, details: t.details, status: t.status, assignee: t.assignee, dependsOn: t.dependsOn })),
          messages: selectPeerMessages(board.snapshot().messages, scope), lastResult: state.lastResult,
          budget: { remainingCalls: o.maxCalls === 0 ? null : o.maxCalls - state.calls, remainingMs: o.deadline === 0 ? null : remainingRunMs(o.deadline) } };
        let usage: import('../agents/llm.ts').AskUsage | undefined;
        let actualModel = o.ask.model ?? 'configured';
        let spend: { reservedUsd?: string; chargedUsd?: string } = {};
        let output: FactorioDecision;
        try {
          output = await decideFactorio(o.ask, context, { signal, timeoutMs: Math.min(o.timeoutMs, Math.max(1, remainingRunMs(o.deadline))),
            spend: o.spend, callId: id, onSpend: cost => { spend = { ...spend, ...cost }; },
            onUsage: (reported, model) => { usage = reported; if (model) actualModel = model; } });
        } catch (error) {
          if (!(error instanceof InvalidFactorioDecisionError)) throw error;
          await post(`${id}-audit`, 'inference_audit', { model: actualModel, usage: usage ?? null,
            usageKnown: Boolean(usage), promptChars: JSON.stringify(context).length, remainingCalls: context.budget.remainingCalls,
            reservedUsd: spend.reservedUsd, chargedUsd: spend.chargedUsd, runSpend: o.spend?.snapshot() });
          const reason = 'The previous model response exceeded the decision schema; use shorter bounded fields and retry.';
          await post(`${id}-rejected`, 'decision_rejected', { reason });
          state.lastResult = { kind: 'invalid_model_output', reason }; state.decision = null; o.save(state);
          continue;
        }
        await post(`${id}-audit`, 'inference_audit', { model: actualModel, usage: usage ?? null,
          usageKnown: Boolean(usage), promptChars: JSON.stringify(context).length, remainingCalls: context.budget.remainingCalls,
          reservedUsd: spend.reservedUsd, chargedUsd: spend.chargedUsd, runSpend: o.spend?.snapshot() });
        state.decision = { id, output }; o.save(state);
      }
      const { id, output } = state.decision;
      withinRun(); await waitReady(); snapshot();
      observed = await observe();
      if (observed.paused) { await sleep(500); continue; }
      await post(`${id}-decision`, 'decision', { actorId: scope.actorId, model: o.ask.model ?? 'injected', output });
      if (output.kind === 'chat') {
        const repeated = repeatsLatestChat(board.snapshot().messages, scope, output.recipient, output.message);
        if (!repeated) await post(`${id}-chat`, 'chat', { text: output.message, actorId: scope.actorId }, output.recipient);
        state.lastResult = { kind: 'chat', recipient: output.recipient, ...(repeated ? {suppressed: 'Unchanged announcement already delivered; act or wait until something changes'} : {}) }; state.decision = null; o.save(state);
      } else if (output.kind === 'wait') {
        state.lastResult = { kind: 'wait', reason: output.message }; state.decision = null; o.save(state);
        await sleep(output.waitMs);
      } else if (output.kind === 'complete') {
        const engineStatus = await o.game({ kind: 'status' }) as { rocketLaunches?: number; furnaces?: number; automation?: { verified: boolean } };
        const won = o.goal === 'rocket' ? Number(engineStatus.rocketLaunches) >= 1
          : engineStatus.automation?.verified === true;
        if (!won) {
          state.lastResult = { error: o.goal === 'rocket' ? 'Completion rejected: no engine-observed rocket launch'
            : 'Completion rejected: engine must verify unattended mining, smelting and plate storage for 60 game seconds' }; state.decision = null; o.save(state); continue;
        }
        await post(`${id}-complete`, 'completion', { taskId: o.taskId, inventory: observed.inventory, tick: observed.tick,
          rocketLaunches: engineStatus.rocketLaunches, furnaces: engineStatus.furnaces, automation: engineStatus.automation });
        leases.stop();
        for (const r of board.snapshot().reservations.filter(r => r.holder === scope.sender && r.taskId === o.taskId)) {
          leases.release(r.path); await board.releaseReservation(scope.sender, r.path);
        }
        snapshot();
        await board.updateTask(scope.sender, o.taskId, 'done', o.goal === 'rocket'
          ? `Engine rocket launch observed by actor ${scope.actorId} at tick ${observed.tick}`
          : `Game verified unattended ore mining, smelting and plate storage at tick ${observed.tick}`);
        state.decision = null; o.save(state); return;
      } else if (output.kind === 'subtask' || output.kind === 'resource_request') {
        const taskId = `${scope.runId}.subtask-${scope.actorId}-${state.calls}`;
        const request = JSON.parse(output.message) as Record<string, unknown>;
        if (output.kind === 'resource_request' && !observed.nearby.some(e => e.unit === request.boxId && e.type === 'container')) {
          state.lastResult = { error: 'Resource box must be an observed container' }; state.decision = null; o.save(state); continue;
        }
        const dependsOn = output.kind === 'subtask' ? String(request.dependsOn ?? '') : '';
        if (dependsOn && !dependsOn.startsWith(`${scope.runId}.`)) {
          state.lastResult = { error: 'Subtask dependency must belong to this run' }; state.decision = null; o.save(state); continue;
        }
        if (!board.snapshot().tasks.some(t => t.id === taskId)) await board.createTask(scope.sender, {
          id: taskId,
          title: output.kind === 'resource_request' ? `Deliver ${request.quantity} ${request.item} to box ${request.boxId}` : String(request.title),
          details: output.kind === 'resource_request'
            ? `${JSON.stringify({ runId: scope.runId, worldId: scope.worldId, requestedBy: scope.sender, item: request.item, quantity: request.quantity, boxId: request.boxId })}\npush when finished`
            : `${String(request.details)}\nParent goal: ${scope.runId}.goal-${o.goal === 'rocket' ? 'rocket' : 'plates'}; world ${scope.worldId}; push when finished`,
          area: output.kind === 'resource_request' ? 'factorio-resource' : 'factorio-subtask', dependsOn });
        await post(`${id}-task`, output.kind, { taskId, ...request });
        state.lastResult = { kind: output.kind, taskId }; state.decision = null; o.save(state);
      } else if (output.kind === 'claim_subtask' || output.kind === 'finish_subtask') {
        const task = board.snapshot().tasks.find(t => t.id === output.message && t.id.startsWith(`${scope.runId}.subtask-`));
        if (!task) { state.lastResult = { error: 'Subtask missing from this run' }; state.decision = null; o.save(state); continue; }
        if (task.id === o.taskId) { state.lastResult = { error: 'The assigned goal task requires verified objective completion, not finish_subtask' }; state.decision = null; o.save(state); continue; }
        if (Array.from({length: 5}, (_, i) => `${scope.runId}.subtask-orchestrator-${i + 1}`).includes(task.id)) {
          state.lastResult = {error: 'Initial actor assignments are protected; use later coordinator-created subtasks for incremental work'};
          state.decision = null; o.save(state); continue;
        }
        if (output.kind === 'claim_subtask') {
          if (task.status === 'open') await board.claimTask(scope.sender, task.id);
          else if (task.assignee !== scope.sender) { state.lastResult = { error: 'Subtask already claimed', assignee: task.assignee }; state.decision = null; o.save(state); continue; }
        } else {
          if (task.status !== 'claimed' || task.assignee !== scope.sender) { state.lastResult = { error: 'Subtask not held by actor' }; state.decision = null; o.save(state); continue; }
          const receipt = state.lastResult as Receipt | null;
          if (!receipt || receipt.status !== 'completed' || receipt.actorId !== scope.actorId) { state.lastResult = { error: 'Subtask needs a completed game receipt' }; state.decision = null; o.save(state); continue; }
          if (task.area === 'factorio-resource') {
            const request = JSON.parse(task.details.split('\n')[0]) as { item: string; quantity: number; boxId: number };
            if (receipt.item !== request.item || receipt.targetId !== request.boxId || (receipt.quantity ?? 0) < request.quantity) {
              state.lastResult = { error: 'Resource request requires matching box deposit receipt' }; state.decision = null; o.save(state); continue;
            }
          }
          await board.updateTask(scope.sender, task.id, 'done', `Game receipt ${receipt.operationId} by actor ${scope.actorId}`);
        }
        await post(`${id}-task`, output.kind, { taskId: task.id });
        state.lastResult = { kind: output.kind, taskId: task.id }; state.decision = null; o.save(state);
      } else {
        const command = output.command!;
        let reservationPath: string | undefined;
        if (command.kind === 'research') {
          reservationPath = `world/${scope.worldId}/force/player/research`;
        } else if (command.kind === 'take' || command.kind === 'put' || command.kind === 'set_recipe') {
          const target = observed.nearby.find(e => e.unit === command.targetId);
          if (!target || Math.hypot(observed.x - target.x, observed.y - target.y) > 5) {
            state.lastResult = { error: 'Target not observed within reach; move closer first' }; state.decision = null; o.save(state); continue;
          }
          reservationPath = `world/${scope.worldId}/entity/${command.targetId}`;
        } else if (command.kind === 'pickup') {
          const target=observed.nearby.find(e=>e.type==='item-entity' && Math.hypot(e.x-command.x,e.y-command.y)<0.05);
          if(!target || Math.hypot(observed.x-target.x,observed.y-target.y)>5) {
            state.lastResult={error:'Ground item not observed within reach'};state.decision=null;o.save(state);continue;
          }
          reservationPath=`world/${scope.worldId}/tile/${Math.floor(command.x)}/${Math.floor(command.y)}`;
        } else if (command.kind === 'mine') {
          const target = observed.nearby.find(e => e.name === command.name && ['tree', 'resource'].includes(e.type) && Math.hypot(e.x - command.x, e.y - command.y) < 0.7);
          if (!target || Math.hypot(observed.x - target.x, observed.y - target.y) > 5) {
            state.lastResult = { error: 'Mine target not observed within reach' }; state.decision = null; o.save(state); continue;
          }
          reservationPath = `world/${scope.worldId}/resource/${command.name}/${Math.round(command.x * 100)}/${Math.round(command.y * 100)}`;
        } else if (command.kind === 'recover') {
          const target = observed.nearby.find(e => e.unit === command.targetId && !['tree','resource'].includes(e.type));
          if (!target || Math.hypot(observed.x-target.x, observed.y-target.y)>5) { state.lastResult={error:'Recover target not observed within reach'}; state.decision=null; o.save(state); continue; }
          reservationPath = `world/${scope.worldId}/entity/${command.targetId}`;
        } else if (command.kind === 'place' || command.kind === 'build') {
          if (Math.hypot(observed.x - command.x, observed.y - command.y) > 5 || (observed.inventory.items?.[command.item] ?? 0) < 1) {
            state.lastResult = { error: 'Place item absent or target out of reach' }; state.decision = null; o.save(state); continue;
          }
          reservationPath = `world/${scope.worldId}/tile/${Math.floor(command.x)}/${Math.floor(command.y)}`;
        }
        if (reservationPath) {
          const other = board.snapshot().reservations.find(r => r.path === reservationPath && r.holder !== scope.sender &&
            r.expiresAt.microsSinceUnixEpoch > BigInt(Date.now()) * 1000n);
          if (other) { state.lastResult = { error: 'Resource held by peer', holder: other.holder }; state.decision = null; o.save(state); continue; }
          try { await board.reserve(scope.sender, reservationPath, o.taskId, 'Inference actor resource lease', 1); }
          catch {
            // Another actor may win between the local snapshot and atomic reducer.
            state.lastResult = { error: 'Resource reservation refused; refresh peer state and choose another step' };
            state.decision = null; o.save(state); await sleep(250); continue;
          }
          for (let i = 0; i < 40 && !board.snapshot().reservations.some(r => r.path === reservationPath && r.holder === scope.sender); i++) { withinRun(); await sleep(100); }
          if (!board.snapshot().reservations.some(r => r.path === reservationPath && r.holder === scope.sender)) throw Error('Reservation not applied');
          leases.track(reservationPath);
        }
        withinRun(); snapshot(); observed = await observe();
        if (observed.paused) continue;
        withinRun(); snapshot();
        if (reservationPath && !board.snapshot().reservations.some(r => r.path === reservationPath && r.holder === scope.sender && r.taskId === o.taskId && r.expiresAt.microsSinceUnixEpoch > BigInt(Date.now()) * 1000n)) throw Error('Reservation expired before mutation');
        const operationId = `${scope.runId}-${scope.sender}-act-${state.calls}`;
        const { digest } = encodeOperation({ version: 1, ...{ worldId: scope.worldId, historyId: scope.historyId }, operationId, actorId: scope.actorId, command });
        state.pending = { id: operationId, command, digest }; o.save(state);
        let first: unknown;
        try { first = await o.game({ kind: 'execute', actor: scope.actorId, operation: operationId, command }); }
        catch { /* The request may have reached the game. Poll its receipt; never replay. */ }
        const receipt = await reconcileReceipt(state.pending, state.tick, first);
        state.lastResult = receipt; state.tick = receipt.endTick!; state.pending = null; state.decision = null; o.save(state);
        await post(operationId, 'action_result', receipt);
        // Furnaces stay reserved while smelting. Other resources are shared after each transfer.
        if (reservationPath && !(command.kind === 'put' && observed.nearby.find(e => e.unit === command.targetId)?.type === 'furnace')) {
          leases.release(reservationPath); await board.releaseReservation(scope.sender, reservationPath);
        }
      }
      await sleep(250);
    }
  } finally { leases.stop(); }
}

function atomicSave(path: string, value: unknown): void {
  const temporary = `${path}.tmp`; const fd = openSync(temporary, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directoryFd = openSync(dirname(path), 'r');
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}
export async function inferenceWorkerMain(): Promise<void> {
  const [worldText, indexText, actorText, runId] = process.argv.slice(2);
  const actorId = Number(actorText), index = Number(indexText);
  if (!worldText || !runId || !/^[a-z0-9_.-]{1,36}$/.test(runId) || !Number.isSafeInteger(index) || index < 1 || index > 10 || !Number.isSafeInteger(actorId) || actorId < 1) throw Error('Usage: inference-worker WORLD INDEX ACTOR RUN');
  const world = resolve(worldText), manifest = JSON.parse(readFileSync(join(world, 'manifest.json'), 'utf8'));
  const scope: FactorioScope = { runId, worldId: manifest.worldId, historyId: manifest.historyId, actorId, sender: `${runId}-agent-${index}` };
  const directory = join(world, 'inference', scope.sender); mkdirSync(directory, { recursive: true, mode: 0o700 });
  // All runs sharing this world use the same lock for a given physical actor.
  const processPath = join(world, 'inference', `actor-${actorId}.pid`);
  if (existsSync(processPath)) {
    const pid = Number(readFileSync(processPath, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw Error('Corrupt worker process lock');
    try { process.kill(pid, 0); throw Error('Inference actor worker already running'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    unlinkSync(processPath);
  }
  const processFd = openSync(processPath, 'wx', 0o600); writeFileSync(processFd, String(process.pid)); closeSync(processFd);
  const statePath = join(directory, 'state.json'), tokenPath = join(directory, 'board.token');
  const state: InferenceState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { version: 1, scope, calls: 0, tick: 0, lastResult: null, pending: null, decision: null };
  const provider = process.env.AGENT_BRAIN;
  if (provider !== 'claude' && provider !== 'codex') throw Error('AGENT_BRAIN must explicitly select claude or codex');
  const spendFile = process.env.FACTORIO_RUN_SPEND_FILE;
  if (!spendFile) throw Error('FACTORIO_RUN_SPEND_FILE is required; refusing uncapped model calls');
  const spend = createFactorioSpendGuard({ path: spendFile, runId, worldId: manifest.worldId, historyId: manifest.historyId,
    capUsd: process.env.FACTORIO_RUN_BUDGET_USD ?? '400' });
  const board = new MessageBoardClient({ uri: process.env.BOARD_URI ?? manifest.boardHost ?? 'ws://127.0.0.1:3000', database: process.env.BOARD_DATABASE ?? 'quant-swarm-factorio-coord',
    token: existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8') : undefined, onToken: token => atomicSaveToken(tokenPath, token) });
  const controller = new AbortController();
  const stop = () => { controller.abort(new Error('Worker stopped')); board.stop(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const deadlinePath = join(directory, 'deadline.json');
  const requestedDeadline = Number(process.env.FACTORIO_RUN_DEADLINE);
  const deadline = existsSync(deadlinePath) ? JSON.parse(readFileSync(deadlinePath, 'utf8')).deadline
    : Number.isSafeInteger(requestedDeadline) && requestedDeadline >= 0 ? requestedDeadline : deadlineFromDuration(Number(process.env.FACTORIO_RUN_MS ?? 0));
  if (!existsSync(deadlinePath)) atomicSave(deadlinePath, { deadline });
  board.start();
  try {
    await runInferenceWorker({ scope, state, taskId: process.env.FACTORIO_TASK_ID ?? `${runId}.production-${index}`,
      objective: process.env.FACTORIO_OBJECTIVE ?? (process.env.FACTORIO_GOAL === 'rocket'
        ? 'Beat Factorio by launching a rocket from this empty-resource freeplay world. Decompose the goal into board subtasks and cooperate through resource requests and shared chests.'
        : 'Start empty, gather natural materials, craft and assemble an automated iron factory: automatic ore and fuel acquisition, smelting and plate delivery into storage. Manual bootstrap work is allowed; no ongoing actor feeding or hauling after commissioning. Completion requires status.automation.verified.'),
      operatorPrompt: () => process.env.FACTORIO_PROMPT_FILE ? readFileSync(process.env.FACTORIO_PROMPT_FILE, 'utf8') : process.env.FACTORIO_PROMPT ?? 'Share plans and observations; avoid resource contention.',
      maxCalls: Number(process.env.FACTORIO_MAX_CALLS ?? 30), requiredPlates: process.env.FACTORIO_GOAL === 'rocket' ? 0 : Number(process.env.FACTORIO_REQUIRED_PLATES ?? 5),
      goal: process.env.FACTORIO_GOAL === 'rocket' ? 'rocket' : 'plates', deadline,
      timeoutMs: Number(process.env.FACTORIO_INFERENCE_TIMEOUT_MS ?? 60000), ask: createAsker(provider), board,
      spend, game: request => new Promise((resolve, reject) => {
        const child = execFile('python3', ['factorio/worker-bridge.py', world], {encoding:'utf8',timeout:25000,maxBuffer:4*1024*1024}, (error, stdout) => {
          if (error) { reject(error); return; }
          try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
        });
        child.stdin?.on('error', reject); child.stdin?.end(JSON.stringify(request));
      }),
      save: value => atomicSave(statePath, value), signal: controller.signal });
  } finally { board.stop(); unlinkSync(processPath); }
}
function atomicSaveToken(path: string, token: string): void {
  const temporary = `${path}.tmp`; writeFileSync(temporary, token, { mode: 0o600 }); renameSync(temporary, path);
}

/** Only transient board/renewal transport errors restart; unknown game effects quarantine. */
export function inferenceFailureExitCode(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Unknown game outcome') || message.includes('Receipt from future history')) return 78;
  if (error instanceof ResourceRenewalUncertain || message === 'Board disconnected') return 75;
  if (isTransientTransportFailure(error)) return RETRYABLE_TRANSPORT_FAILURE;
  return 1;
}
