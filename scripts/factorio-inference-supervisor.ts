import { deadlineFromDuration } from '../src/factorio/run-duration.ts';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { supervise } from '../src/factorio/worker-supervisor.ts';

async function main(): Promise<void> {
  const [worldText, indexText, actorText, runId, workerText] = process.argv.slice(2);
  if (!worldText || !indexText || !actorText || !runId || !workerText) {
    throw Error('Usage: factorio-inference-supervisor WORLD INDEX ACTOR RUN WORKER_SCRIPT');
  }
  const world = resolve(worldText), worker = resolve(workerText);
  const runMs = Number(process.env.FACTORIO_RUN_MS ?? 0);
  if (!Number.isSafeInteger(runMs) || runMs < 0) throw Error('Invalid FACTORIO_RUN_MS');
  const statePath = join(world, 'inference', runId, `agent-${indexText}.supervisor.json`);
  const savedState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as { deadline?: number } : undefined;
  const requestedDeadline = Number(process.env.FACTORIO_RUN_DEADLINE);
  const deadline = savedState?.deadline ?? (Number.isSafeInteger(requestedDeadline) && requestedDeadline >= 0 ? requestedDeadline : deadlineFromDuration(runMs));
  const exitCode = await supervise({ statePath, runId: `${runId}-agent-${indexText}`,
    deadline, command: process.execPath,
    args: [worker, world, indexText, actorText, runId] });
  process.exitCode = exitCode;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
