import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageBoardClient } from '../message-board/client.ts';
import { inferenceLaunchPlan } from '../src/factorio/inference-launch.ts';
import { createFactorioSpendGuard } from '../src/factorio/run-spend.ts';

async function main() {
  const args = process.argv.slice(2), start = args.includes('--start');
  const [worldText, runId] = args.filter(a => a !== '--start');
  if (!worldText || !runId) throw Error('Usage: factorio-inference-swarm WORLD RUN [--start] (dry-run is default)');
  const world = resolve(worldText), manifest = JSON.parse(readFileSync(join(world, 'manifest.json'), 'utf8'));
  const goal = process.env.FACTORIO_GOAL ?? 'plates';
  if (!['plates', 'rocket'].includes(goal) || (goal === 'rocket' && manifest.scenario !== 'freeplay')) throw Error('Rocket goal requires a declared freeplay world');
  const status = JSON.parse(execFileSync('python3', ['factorio/worker-bridge.py', world], { input: '{"kind":"status"}', encoding: 'utf8', timeout: 25000 }));
  if (status.world?.worldId !== manifest.worldId || status.world?.historyId !== manifest.historyId) throw Error('Game world differs from manifest');
  const plan = inferenceLaunchPlan({ runId, actorIds: status.actors.map((a: { unit: number }) => a.unit),
    provider: process.env.AGENT_BRAIN ?? '', model: process.env.AGENT_MODEL ?? '',
    ...(process.env.FACTORIO_ACTOR_MODEL ? { actorModel: process.env.FACTORIO_ACTOR_MODEL } : {}),
    maxCalls: Number(process.env.FACTORIO_MAX_CALLS), runMs: Number(process.env.FACTORIO_RUN_MS),
    ...(process.env.FACTORIO_ORCHESTRATOR_MAX_CALLS ? { orchestratorMaxCalls: Number(process.env.FACTORIO_ORCHESTRATOR_MAX_CALLS) } : {}),
    ...(process.env.FACTORIO_RUN_BUDGET_USD ? { maxRunSpendUsd: process.env.FACTORIO_RUN_BUDGET_USD } : {}),
    mode: process.env.FACTORIO_DEMO_MODE as 'smoke' | 'production' | undefined });
  const providerKey = plan.provider === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  console.log(JSON.stringify({ mode: start ? 'start' : 'dry-run', goal, worldId: manifest.worldId, historyId: manifest.historyId,
    ...plan, credentialConfigured: Boolean(process.env[providerKey]), paused: status.paused }, null, 2));
  if (!start) return;
  if (!process.env[providerKey]) throw Error(`Configure ${providerKey} securely in the worker environment before --start`);
  if (status.paused) throw Error('Game world is paused');
  const workerScript = resolve('dist/factorio-inference-worker.mjs');
  const supervisorScript = resolve('dist/factorio-inference-supervisor.mjs');
  const orchestratorScript = resolve('dist/factorio-inference-orchestrator.mjs');
  if (!existsSync(workerScript) || !existsSync(supervisorScript) || !existsSync(orchestratorScript)) throw Error('Build the Factorio worker, supervisor and orchestrator bundles first');
  const promptFiles = plan.workers.map(worker => {
    const file = process.env.FACTORIO_PROMPT_DIR ? resolve(process.env.FACTORIO_PROMPT_DIR, `agent-${worker.index}.txt`) : process.env.FACTORIO_PROMPT_FILE;
    if (file && !existsSync(file)) throw Error(`Missing prompt file for actor ${worker.actorId}`);
    return file;
  });
  const directory = join(world, 'inference', runId); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const planPath = join(directory, 'plan.json');
  const savedPlan = { worldId: manifest.worldId, historyId: manifest.historyId, goal, ...plan };
  if (existsSync(planPath) && JSON.stringify(JSON.parse(readFileSync(planPath, 'utf8'))) !== JSON.stringify(savedPlan)) throw Error('Run ID already has a different actor/model/budget mapping; choose a new run ID');
  const spendFile = join(directory, 'run-spend.json');
  if (existsSync(planPath) && !existsSync(spendFile)) throw Error('Run spend ledger is missing; refusing to restart without its spend history');
  const spend = createFactorioSpendGuard({ path: spendFile, runId, worldId: manifest.worldId, historyId: manifest.historyId, capUsd: plan.maxRunSpendUsd });
  if (!existsSync(planPath)) writeFileSync(planPath, JSON.stringify(savedPlan, null, 2), { flag: 'wx', mode: 0o600 });
  const tokenPath = join(directory, 'orchestrator.token');
  const board = new MessageBoardClient({ uri: process.env.BOARD_URI ?? manifest.boardHost ?? 'ws://127.0.0.1:3000', database: process.env.BOARD_DATABASE ?? 'quant-swarm-factorio-coord',
    token: existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8') : undefined,
    onToken: token => writeFileSync(tokenPath, token, { mode: 0o600 }) });
  const children: ChildProcess[] = [];
  let stopping = false;
  let stopTimer: NodeJS.Timeout | undefined;
  let spendMonitor: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const groupAlive = (child: ChildProcess) => {
    if (!child.pid) return false;
    if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  };
  const signalGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, signal); return; } catch { /* Fall back to the role process. */ }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const stop = () => {
    stopping = true;
    for (const child of children) signalGroup(child, 'SIGTERM');
    if (!killTimer && children.some(groupAlive)) {
      killTimer = setTimeout(() => {
        for (const child of children) if (groupAlive(child)) signalGroup(child, 'SIGKILL');
      }, 5000);
    }
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  board.start();
  try {
    const until = Date.now() + 30000;
    while (!board.ready && !stopping) { if (Date.now() >= until) throw Error('Board connection unavailable'); await new Promise(r => setTimeout(r, 200)); }
    if (stopping) return;
    // Bootstrap and create initial tasks using the orchestrator identity. Its
    // worker reuses the saved token, so setup does not add a seventh row.
    try { await board.bootstrapOperator(); } catch (error) {
      if (!String(error).includes('already configured')) throw error;
    }
    await board.setParticipantLimit(8);
    await board.register(plan.orchestrator.sender, 'factorio-orchestrator', `Board-only coordinator; five ${plan.actorModel} low-effort game actors; ${plan.orchestrator.model} high effort`);
    const goalTaskId = `${runId}.goal-${goal}`;
    if (!board.snapshot().tasks.some(t => t.id === goalTaskId)) {
      const title = goal === 'rocket' ? 'Beat Factorio: launch a rocket' : 'Build a fully automated iron plate factory';
      const details = goal === 'rocket'
        ? `World ${manifest.worldId}; history ${manifest.historyId}; zero fixture resources; engine rocket-launch event is the only victory proof. The overseer must create one run-scoped subtask per actor before workers start.`
        : `World ${manifest.worldId}; history ${manifest.historyId}. Build a fully automated iron plate factory using the declared supplied machine kit. Machines must mine natural iron ore, smelt it and automatically deposit plates in storage. No manual actor feeding or hauling counts. Completion requires engine status.automation.verified after 60 game seconds of unattended production. The overseer must create one run-scoped subtask per actor before workers start.`;
      await board.createTask(plan.orchestrator.sender, { id: goalTaskId, title, area: 'factorio-goal', details, priority: 'high' });
    }
    if (!board.snapshot().messages.some(row => {
      try { const body = JSON.parse(row.body); return row.sender === plan.orchestrator.sender && body.runId === runId && body.eventId === `${runId}-budget`; }
      catch { return false; }
    })) {
      await board.post(plan.orchestrator.sender, JSON.stringify({ version: 1, runId, worldId: manifest.worldId, historyId: manifest.historyId,
        sender: plan.orchestrator.sender, eventId: `${runId}-budget`, kind: 'run_budget',
        payload: { capUsd: spend.snapshot().capUsd, priceVersion: plan.spendPriceVersion, actors: plan.actorModel, overseer: plan.orchestrator.model } }), '', goalTaskId);
    }
    const deadlinePath = join(directory, 'orchestrator-deadline.json');
    const configuredDeadline = Date.now() + plan.runMs;
    const savedDeadline = existsSync(deadlinePath) ? Number(JSON.parse(readFileSync(deadlinePath, 'utf8')).deadline) : configuredDeadline;
    if (!Number.isSafeInteger(savedDeadline) || savedDeadline <= Date.now()) throw Error('Persisted run deadline has expired; refusing to extend this run');
    const runDeadline = Math.min(configuredDeadline, savedDeadline);
    stopTimer = setTimeout(stop, Math.max(0, plan.runMs));
    // A rejected reservation commits halted=true before the requesting worker
    // exits. Watch the atomic ledger so every sibling stops immediately too.
    spendMonitor = setInterval(() => {
      try {
        const snapshot = spend.snapshot();
        if (snapshot.halted) {
          console.error(`Run spend guard halted ${runId}: ${snapshot.haltReason ?? 'budget exhausted'}`);
          stop();
        }
      } catch (error) {
        console.error(`Run spend ledger unavailable; stopping ${runId}: ${String(error)}`);
        stop();
      }
    }, 100);
    spendMonitor.unref();
    const baseEnv = { ...process.env, FACTORIO_MAX_CALLS: String(plan.maxCalls ?? 0), FACTORIO_RUN_DEADLINE: String(runDeadline), FACTORIO_RUN_SPEND_FILE: spendFile,
      FACTORIO_RUN_BUDGET_USD: plan.maxRunSpendUsd };
    type ChildResult = { role: 'actor' | 'orchestrator'; actorId?: number; code: number | null; signal?: string | null };
    const results: Promise<ChildResult>[] = [];
    const targets = plan.workers.map(worker => ({ worker, taskId: worker.taskId }));
    let actorsReady = false, prematureActorExit: string | undefined;
    // Register each actor identity first. Workers stay idle until their directed
    // task announcement arrives, allowing the overseer to message real recipients.
    for (const { worker, taskId } of targets) {
      const promptFile = promptFiles[worker.index - 1];
      const log = openSync(join(directory, `agent-${worker.index}.log`), 'a', 0o600);
      const child = spawn(process.execPath, [supervisorScript, world, String(worker.index), String(worker.actorId), runId, workerScript], {
        detached: process.platform !== 'win32',
        env: { ...baseEnv, AGENT_MODEL: plan.actorModel, AGENT_EFFORT: plan.actorEffort, FACTORIO_TASK_ID: taskId,
          FACTORIO_OBJECTIVE: goal === 'rocket'
            ? 'Wait for the Astra overseer to create and announce your run-scoped rocket task before acting.'
            : 'Wait for the Astra overseer to create and announce your run-scoped iron plate factory task before acting.',
          ...(promptFile ? { FACTORIO_PROMPT_FILE: promptFile } : {}) }, stdio: ['ignore', log, log] });
      closeSync(log); children.push(child);
      results.push(new Promise(resolveResult => {
        let resolved = false;
        child.once('error', () => {
          prematureActorExit = `Actor ${worker.actorId} process failed to start`;
          if (!resolved) { resolved = true; resolveResult({ role: 'actor', actorId: worker.actorId, code: 1 }); }
        });
        child.once('exit', (code, signal) => {
          if (!actorsReady && (code !== null || signal)) prematureActorExit = `Actor ${worker.actorId} exited before overseer assignment`;
          if (!resolved) { resolved = true; resolveResult({ role: 'actor', actorId: worker.actorId, code, signal }); }
        });
      }));
    }
    const registrationDeadline = Math.min(runDeadline, Date.now() + 30000);
    while (!stopping) {
      const registered = targets.every(({ worker }) => board.snapshot().participants.some(participant => participant.name === worker.sender));
      if (registered) break;
      if (prematureActorExit) throw Error(prematureActorExit);
      if (Date.now() >= registrationDeadline) throw Error('Five Luna actor identities did not register before the startup deadline');
      await new Promise(r => setTimeout(r, 100));
    }
    if (stopping) throw Error('Run stopped before actor registration completed');

    const coordinatorLog = openSync(join(directory, 'orchestrator.log'), 'a', 0o600);
    const orchestrator = spawn(process.execPath, [orchestratorScript, world, runId], {
      detached: process.platform !== 'win32',
      env: { ...baseEnv, AGENT_MODEL: plan.orchestrator.model, AGENT_EFFORT: plan.orchestrator.effort,
      FACTORIO_ORCHESTRATOR_MAX_CALLS: String(plan.orchestrator.maxCalls ?? 0), FACTORIO_RUN_MS: String(plan.runMs) },
      stdio: ['ignore', coordinatorLog, coordinatorLog] });
    closeSync(coordinatorLog); children.push(orchestrator);
    let orchestratorExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const orchestratorResult = new Promise<ChildResult>(resolveResult => {
      orchestrator.once('error', () => { orchestratorExit = { code: 1, signal: null }; resolveResult({ role: 'orchestrator', code: 1 }); });
      orchestrator.once('exit', (code, signal) => { orchestratorExit = { code, signal }; resolveResult({ role: 'orchestrator', code, signal }); });
    });
    results.push(orchestratorResult);

    // Hold all actors idle until Astra creates each task and sends its directed
    // announcement. The launcher never creates these actor tasks.
    const assignmentDeadline = runDeadline;
    while (!stopping) {
      const snapshot = board.snapshot();
      const assigned = targets.every(({ worker, taskId }) => {
        const task = snapshot.tasks.find(row => row.id === taskId && row.area === 'factorio-orchestration');
        const announced = snapshot.messages.some(row => {
          if (row.sender !== plan.orchestrator.sender || row.recipient !== worker.sender) return false;
          try {
            const body = JSON.parse(row.body);
            return body.runId === runId && body.kind === 'orchestrator_task' && body.payload?.taskId === taskId;
          } catch { return false; }
        });
        return Boolean(task && announced);
      });
      if (assigned) break;
      if (prematureActorExit) throw Error(prematureActorExit);
      if (orchestratorExit) throw Error(`Astra overseer exited before creating all five actor subtasks (${orchestratorExit.code ?? orchestratorExit.signal})`);
      if (Date.now() >= assignmentDeadline) throw Error('Astra overseer did not create and announce all five actor subtasks before the startup deadline');
      await new Promise(r => setTimeout(r, 250));
    }
    if (stopping) throw Error('Run stopped before overseer task assignment completed');
    actorsReady = true;
    const completed = await Promise.all(results);
    console.log(JSON.stringify({ runId, results: completed, spend: spend.snapshot(), logs: directory }));
    if (completed.some(r => r.code !== 0)) process.exitCode = 1;
  } finally {
    if (stopTimer) clearTimeout(stopTimer);
    if (spendMonitor) clearInterval(spendMonitor);
    stop(); board.stop();
    if (killTimer && !children.some(groupAlive)) { clearTimeout(killTimer); killTimer = undefined; }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
