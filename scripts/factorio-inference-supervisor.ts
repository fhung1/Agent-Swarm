import { join, resolve } from 'node:path';
import { supervise } from '../src/factorio/worker-supervisor.ts';

async function main(): Promise<void> {
  const [worldText, indexText, actorText, runId, workerText] = process.argv.slice(2);
  if (!worldText || !indexText || !actorText || !runId || !workerText) {
    throw Error('Usage: factorio-inference-supervisor WORLD INDEX ACTOR RUN WORKER_SCRIPT');
  }
  const world = resolve(worldText), worker = resolve(workerText);
  const runMs = Number(process.env.FACTORIO_RUN_MS ?? 900000);
  if (!Number.isSafeInteger(runMs) || runMs < 1) throw Error('Invalid FACTORIO_RUN_MS');
  const statePath = join(world, 'inference', runId, `agent-${indexText}.supervisor.json`);
  const exitCode = await supervise({ statePath, runId: `${runId}-agent-${indexText}`,
    deadline: Date.now() + runMs, command: process.execPath,
    args: [worker, world, indexText, actorText, runId] });
  process.exitCode = exitCode;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
