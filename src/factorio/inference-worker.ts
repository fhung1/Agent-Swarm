import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { MessageBoardClient, type BoardSnapshot } from '../../message-board/client.ts';
import { createAsker, type Ask } from '../agents/llm.ts';
import { decideFactorio, selectPeerMessages, type FactorioScope, type FactorioDecision } from './inference.ts';
import { encodeOperation, type Command, type Receipt } from './protocol.ts';

export interface Observation {
  actorId: number; tick: number; x: number; y: number; world: { worldId: string; historyId: string }; paused: boolean;
  inventory: { ironPlate?: number }; nearby: { unit: number; type: string; x: number; y: number }[];
}
export interface InferenceState {
  version: 1; scope: FactorioScope; calls: number; tick: number; lastResult: unknown;
  pending: { id: string; command: Command; digest: string } | null;
  decision: { id: string; output: FactorioDecision } | null;
}
type WorkerBoard = Pick<MessageBoardClient, 'ready' | 'snapshot' | 'register' | 'post' | 'claimTask' | 'updateTask' | 'reserve' | 'releaseReservation'>;
export interface InferenceWorkerOptions {
  scope: FactorioScope; taskId: string; objective: string; operatorPrompt: () => string;
  maxCalls: number; deadline: number; timeoutMs: number; requiredPlates: number;
  ask: Ask; board: WorkerBoard; game: (request: Record<string, unknown>) => unknown;
  state: InferenceState; save: (state: InferenceState) => void; sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export function validateObservation(value: unknown, scope: FactorioScope, minimumTick: number): Observation {
  const o = value as Observation;
  if (!o || o.actorId !== scope.actorId || o.world?.worldId !== scope.worldId || o.world?.historyId !== scope.historyId ||
    !Number.isSafeInteger(o.tick) || o.tick < minimumTick || !Number.isFinite(o.x) || !Number.isFinite(o.y) ||
    typeof o.paused !== 'boolean' || !o.inventory || !Array.isArray(o.nearby)) throw Error('Foreign, stale or invalid game observation');
  return o;
}
export function assertTaskOwnership(snapshot: BoardSnapshot, taskId: string, sender: string): void {
  const task = snapshot.tasks.find(t => t.id === taskId);
  if (!task || task.status !== 'claimed' || task.assignee !== sender) throw Error('Task ownership lost');
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
  if (!Number.isSafeInteger(o.maxCalls) || o.maxCalls < 1 || o.maxCalls > 1000 || !Number.isSafeInteger(o.requiredPlates) || o.requiredPlates < 1 || !Number.isFinite(o.deadline)) throw Error('Invalid worker limits');
  if (state.version !== 1 || JSON.stringify(state.scope) !== JSON.stringify(scope) || !Number.isSafeInteger(state.calls) || state.calls < 0 || !Number.isSafeInteger(state.tick) || state.tick < 0) throw Error('Foreign or corrupt inference journal');
  const sleep = o.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const withinRun = () => { o.signal?.throwIfAborted(); if (Date.now() >= o.deadline) throw Error('Run deadline reached'); };
  const waitReady = async () => { while (!board.ready) { withinRun(); await sleep(250); } };
  const snapshot = () => { if (!board.ready) throw Error('Board disconnected'); const s = board.snapshot(); assertTaskOwnership(s, o.taskId, scope.sender); return s; };
  const observe = () => {
    const observed = validateObservation(o.game({ kind: 'observe', actor: scope.actorId }), scope, state.tick);
    state.tick = observed.tick; o.save(state); return observed;
  };
  const post = async (id: string, kind: string, payload: unknown, recipient = '') => {
    const s = snapshot();
    if (s.messages.some(m => { try { const e = JSON.parse(m.body); return m.sender === scope.sender && e.runId === scope.runId && e.worldId === scope.worldId && e.historyId === scope.historyId && e.eventId === id; } catch { return false; } })) return;
    await board.post(scope.sender, JSON.stringify({ version: 1, ...scope, taskId: o.taskId, eventId: id, kind, payload }), recipient, o.taskId);
  };
  await waitReady();
  await board.register(scope.sender, 'inference-worker', `actor ${scope.actorId}; run ${scope.runId}`);
  const initial = board.snapshot().tasks.find(t => t.id === o.taskId);
  if (!initial) throw Error('Missing actor task');
  if (initial.status === 'done' && initial.assignee === scope.sender) {
    const observed = observe();
    if (state.pending || (observed.inventory.ironPlate ?? 0) < o.requiredPlates) throw Error('Completed task disagrees with live actor state');
    return;
  }
  if (initial.status === 'open') await board.claimTask(scope.sender, o.taskId);
  // Reducer completion precedes local subscription callbacks.
  for (let i = 0; i < 40; i++) {
    if (board.snapshot().tasks.some(t => t.id === o.taskId && t.status === 'claimed' && t.assignee === scope.sender)) break;
    withinRun(); await sleep(100);
  }
  snapshot();
  if (state.pending) {
    const observed = observe();
    const receipt = checkReceipt(o.game({ kind: 'receipt', operation: state.pending.id }), state.pending, scope, 0);
    if (receipt.endTick! > observed.tick) throw Error('Receipt from future history');
    state.lastResult = receipt; state.pending = null; state.decision = null; o.save(state);
    await post(receipt.operationId, 'action_result', receipt);
  }
  // Retry an uncertain board publication from saved game evidence after reconnect/restart.
  const previousReceipt = state.lastResult as Receipt | null;
  if (previousReceipt?.operationId && previousReceipt.worldId === scope.worldId && previousReceipt.historyId === scope.historyId && previousReceipt.actorId === scope.actorId) {
    await post(previousReceipt.operationId, 'action_result', previousReceipt);
  }
  while (true) {
    withinRun(); await waitReady(); snapshot();
    let observed = observe();
    if (observed.paused) { await sleep(500); continue; }
    const reservations = board.snapshot().reservations.filter(r => r.holder === scope.sender && r.path.startsWith(`world/${scope.worldId}/`));
    for (const reservation of reservations) await board.reserve(scope.sender, reservation.path, o.taskId, 'Inference actor resource lease', 1);
    if (!state.decision) {
      if (state.calls >= o.maxCalls) throw Error('Inference call budget exhausted');
      state.calls++; o.save(state);
      const id = `${scope.runId}-${scope.sender}-infer-${state.calls}`;
      const context = { ...scope, objective: o.objective, operatorPrompt: o.operatorPrompt(), observation: observed,
        status: o.game({ kind: 'status' }), reservations: board.snapshot().reservations.map(r => ({ path: r.path, holder: r.holder })),
        messages: selectPeerMessages(board.snapshot().messages, scope), lastResult: state.lastResult };
      const output = await decideFactorio(o.ask, context, { signal: o.signal, timeoutMs: Math.min(o.timeoutMs, Math.max(1, o.deadline - Date.now())) });
      state.decision = { id, output }; o.save(state);
    }
    const { id, output } = state.decision;
    withinRun(); await waitReady(); snapshot();
    observed = observe();
    if (observed.paused) { await sleep(500); continue; }
    await post(`${id}-decision`, 'decision', { actorId: scope.actorId, model: o.ask.model ?? 'injected', output });
    if (output.kind === 'chat') {
      await post(`${id}-chat`, 'chat', { text: output.message, actorId: scope.actorId }, output.recipient);
      state.lastResult = { kind: 'chat', recipient: output.recipient }; state.decision = null; o.save(state);
    } else if (output.kind === 'wait') {
      state.lastResult = { kind: 'wait', reason: output.message }; state.decision = null; o.save(state);
      await sleep(output.waitMs);
    } else if (output.kind === 'complete') {
      if ((observed.inventory.ironPlate ?? 0) < o.requiredPlates) {
        state.lastResult = { error: 'Completion rejected: live inventory does not satisfy objective' }; state.decision = null; o.save(state); continue;
      }
      await post(`${id}-complete`, 'completion', { inventory: observed.inventory, tick: observed.tick });
      for (const r of board.snapshot().reservations.filter(r => r.holder === scope.sender && r.taskId === o.taskId)) await board.releaseReservation(scope.sender, r.path);
      snapshot();
      await board.updateTask(scope.sender, o.taskId, 'done', `Inference actor ${scope.actorId}: ${observed.inventory.ironPlate} plates observed at tick ${observed.tick}`);
      state.decision = null; o.save(state); return;
    } else {
      const command = output.command!;
      let reservationPath: string | undefined;
      if (command.kind !== 'move') {
        const target = observed.nearby.find(e => e.unit === command.targetId);
        if (!target || Math.hypot(observed.x - target.x, observed.y - target.y) > 5) {
          state.lastResult = { error: 'Target not observed within reach; move closer first' }; state.decision = null; o.save(state); continue;
        }
        reservationPath = `world/${scope.worldId}/entity/${command.targetId}`;
        const other = board.snapshot().reservations.find(r => r.path === reservationPath && r.holder !== scope.sender);
        if (other) { state.lastResult = { error: 'Resource held by peer', holder: other.holder }; state.decision = null; o.save(state); continue; }
        try { await board.reserve(scope.sender, reservationPath, o.taskId, 'Inference transfer resource lease', 1); }
        catch {
          // Another actor may win between the local snapshot and atomic reducer.
          state.lastResult = { error: 'Resource reservation refused; refresh peer state and choose another step' };
          state.decision = null; o.save(state); await sleep(250); continue;
        }
        for (let i = 0; i < 40 && !board.snapshot().reservations.some(r => r.path === reservationPath && r.holder === scope.sender); i++) { withinRun(); await sleep(100); }
        if (!board.snapshot().reservations.some(r => r.path === reservationPath && r.holder === scope.sender)) throw Error('Reservation not applied');
      }
      withinRun(); snapshot(); observed = observe();
      if (observed.paused) continue;
      if (reservationPath && !board.snapshot().reservations.some(r => r.path === reservationPath && r.holder === scope.sender && r.taskId === o.taskId && r.expiresAt.microsSinceUnixEpoch > BigInt(Date.now()) * 1000n)) throw Error('Reservation expired before mutation');
      const operationId = `${scope.runId}-${scope.sender}-act-${state.calls}`;
      const { digest } = encodeOperation({ version: 1, ...{ worldId: scope.worldId, historyId: scope.historyId }, operationId, actorId: scope.actorId, command });
      state.pending = { id: operationId, command, digest }; o.save(state);
      let receipt: Receipt;
      try { receipt = checkReceipt(o.game({ kind: 'execute', actor: scope.actorId, operation: operationId, command }), state.pending, scope, state.tick); }
      catch { receipt = checkReceipt(o.game({ kind: 'receipt', operation: operationId }), state.pending, scope, state.tick); }
      state.lastResult = receipt; state.tick = receipt.endTick!; state.pending = null; state.decision = null; o.save(state);
      await post(operationId, 'action_result', receipt);
      // Furnaces stay reserved while smelting. Other resources are shared after each transfer.
      if (reservationPath && observed.nearby.find(e => e.unit === (command as { targetId: number }).targetId)?.type !== 'furnace') await board.releaseReservation(scope.sender, reservationPath);
    }
    await sleep(250);
  }
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
  const board = new MessageBoardClient({ uri: process.env.BOARD_URI ?? 'ws://127.0.0.1:3000', database: process.env.BOARD_DATABASE ?? 'quant-swarm-factorio-coord',
    token: existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8') : undefined, onToken: token => atomicSaveToken(tokenPath, token) });
  const controller = new AbortController();
  const stop = () => { controller.abort(new Error('Worker stopped')); board.stop(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const deadlinePath = join(directory, 'deadline.json');
  const deadline = existsSync(deadlinePath) ? JSON.parse(readFileSync(deadlinePath, 'utf8')).deadline : Date.now() + Number(process.env.FACTORIO_RUN_MS ?? 900000);
  if (!existsSync(deadlinePath)) atomicSave(deadlinePath, { deadline });
  board.start();
  try {
    await runInferenceWorker({ scope, state, taskId: process.env.FACTORIO_TASK_ID ?? `${runId}.production-${index}`,
      objective: process.env.FACTORIO_OBJECTIVE ?? 'Cooperate with peers and collect five iron plates in your own inventory.',
      operatorPrompt: () => process.env.FACTORIO_PROMPT_FILE ? readFileSync(process.env.FACTORIO_PROMPT_FILE, 'utf8') : process.env.FACTORIO_PROMPT ?? 'Share plans and observations; avoid resource contention.',
      maxCalls: Number(process.env.FACTORIO_MAX_CALLS ?? 30), requiredPlates: Number(process.env.FACTORIO_REQUIRED_PLATES ?? 5), deadline,
      timeoutMs: Number(process.env.FACTORIO_INFERENCE_TIMEOUT_MS ?? 60000), ask: createAsker(provider), board,
      game: request => JSON.parse(execFileSync('python3', ['factorio/worker-bridge.py', world], { input: JSON.stringify(request), encoding: 'utf8', timeout: 25000 })),
      save: value => atomicSave(statePath, value), signal: controller.signal });
  } finally { board.stop(); unlinkSync(processPath); }
}
function atomicSaveToken(path: string, token: string): void {
  const temporary = `${path}.tmp`; writeFileSync(temporary, token, { mode: 0o600 }); renameSync(temporary, path);
}
