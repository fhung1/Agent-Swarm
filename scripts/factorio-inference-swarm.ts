import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageBoardClient } from '../message-board/client.ts';
import { inferenceLaunchPlan } from '../src/factorio/inference-launch.ts';

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
  if (!existsSync(planPath)) writeFileSync(planPath, JSON.stringify(savedPlan, null, 2), { flag: 'wx', mode: 0o600 });
  const tokenPath = join(directory, 'orchestrator.token');
  const board = new MessageBoardClient({ uri: process.env.BOARD_URI ?? manifest.boardHost ?? 'ws://127.0.0.1:3000', database: process.env.BOARD_DATABASE ?? 'quant-swarm-factorio-coord',
    token: existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8') : undefined,
    onToken: token => writeFileSync(tokenPath, token, { mode: 0o600 }) });
  const children: ChildProcess[] = [];
  let stopping = false;
  const stop = () => { stopping = true; for (const child of children) child.kill('SIGTERM'); };
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
    if (goal === 'rocket' && !board.snapshot().tasks.some(t => t.id === `${runId}.goal-rocket`)) {
      await board.createTask(plan.orchestrator.sender, { id: `${runId}.goal-rocket`, title: 'Beat Factorio: launch a rocket', area: 'factorio-goal',
        details: `World ${manifest.worldId}; history ${manifest.historyId}; zero fixture resources; engine rocket-launch event is the only victory proof. Agents create subtasks and resource requests. push when finished`, priority: 'high' });
    }
    for (const worker of plan.workers) {
      const existing = board.snapshot().tasks.find(t => t.id === worker.taskId);
      if (existing && existing.assignee && existing.assignee !== worker.sender) throw Error(`Task ${worker.taskId} belongs to another agent`);
      if (!existing) await board.createTask(plan.orchestrator.sender, { id: worker.taskId, title: goal === 'rocket' ? `Actor ${worker.actorId}: contribute to rocket launch` : `Actor ${worker.actorId}: collect five iron plates`,
        area: 'factorio-inference', details: `Run ${runId}; world ${manifest.worldId}; actor ${worker.actorId}; parent goal ${runId}.goal-rocket. Cooperate through subtasks, resource requests and peer messages. push when finished` });
    }
    const results: Promise<{ role: 'actor' | 'orchestrator'; actorId?: number; code: number | null; signal?: string | null }>[] = plan.workers.map(worker => {
      const promptFile = promptFiles[worker.index - 1];
      const log = openSync(join(directory, `agent-${worker.index}.log`), 'a', 0o600);
      const child = spawn(process.execPath, [supervisorScript, world, String(worker.index), String(worker.actorId), runId, workerScript], {
        env: { ...process.env, AGENT_MODEL: plan.actorModel, AGENT_EFFORT: plan.actorEffort, FACTORIO_TASK_ID: worker.taskId,
          ...(promptFile ? { FACTORIO_PROMPT_FILE: promptFile } : {}) }, stdio: ['ignore', log, log] });
      closeSync(log); children.push(child);
      return new Promise<{ role: 'actor' | 'orchestrator'; actorId?: number; code: number | null; signal?: string | null }>((resolveResult, reject) => {
        child.once('error', reject); child.once('exit', (code, signal) => resolveResult({ role: 'actor', actorId: worker.actorId, code, signal }));
      });
    });
    const coordinatorLog = openSync(join(directory, 'orchestrator.log'), 'a', 0o600);
    const orchestrator = spawn(process.execPath, [orchestratorScript, world, runId], {
      env: { ...process.env, AGENT_MODEL: plan.orchestrator.model, AGENT_EFFORT: plan.orchestrator.effort,
        FACTORIO_ORCHESTRATOR_MAX_CALLS: String(plan.orchestrator.maxCalls), FACTORIO_RUN_MS: String(plan.runMs) },
      stdio: ['ignore', coordinatorLog, coordinatorLog] });
    closeSync(coordinatorLog); children.push(orchestrator);
    results.push(new Promise<{ role: 'actor' | 'orchestrator'; actorId?: number; code: number | null; signal?: string | null }>((resolveResult, reject) => {
      orchestrator.once('error', reject); orchestrator.once('exit', (code, signal) => resolveResult({ role: 'orchestrator', code, signal }));
    }));
    const deadline = setTimeout(stop, plan.runMs + 5000);
    try { const completed = await Promise.all(results); console.log(JSON.stringify({ runId, results: completed, logs: directory })); if (completed.some(r => r.code !== 0)) process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  } finally { stop(); board.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
