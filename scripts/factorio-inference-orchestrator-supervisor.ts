import { deadlineFromDuration } from '../src/factorio/run-duration.ts';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { supervise } from '../src/factorio/worker-supervisor.ts';

async function main(): Promise<void> {
  const [worldText, runId, orchestratorText] = process.argv.slice(2);
  if (!worldText || !runId || !orchestratorText) {
    throw Error('Usage: factorio-inference-orchestrator-supervisor WORLD RUN ORCHESTRATOR_SCRIPT');
  }
  const world = resolve(worldText), orchestrator = resolve(orchestratorText);
  const runMs = Number(process.env.FACTORIO_RUN_MS ?? 0);
  if (!Number.isSafeInteger(runMs) || runMs < 0) throw Error('Invalid FACTORIO_RUN_MS');
  const directory = join(world, 'inference', runId);
  const statePath = join(directory, 'orchestrator.supervisor.json');
  const deadlinePath = join(directory, 'orchestrator-deadline.json');
  const savedDeadline = existsSync(deadlinePath)
    ? Number(JSON.parse(readFileSync(deadlinePath, 'utf8')).deadline)
    : undefined;
  const requestedDeadline = Number(process.env.FACTORIO_RUN_DEADLINE);
  const deadline = savedDeadline ?? (Number.isSafeInteger(requestedDeadline) && requestedDeadline >= 0
    ? requestedDeadline : deadlineFromDuration(runMs));
  const exitCode = await supervise({ statePath, runId: `${runId}-orchestrator`, deadline,
    command: process.execPath, args: [orchestrator, world, runId] });
  process.exitCode = exitCode;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
