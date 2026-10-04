import { supervise } from '../src/factorio/worker-supervisor.ts';

const [statePath, runId, deadlineText, command, ...args] = process.argv.slice(2);
const deadline = Number(deadlineText);
if (!statePath || !runId || !command || !Number.isSafeInteger(deadline) || deadline <= Date.now()) {
  throw Error('Usage: factorio-supervise STATE_PATH RUN_ID DEADLINE_UNIX_MS COMMAND [ARGS...]');
}
process.exitCode = await supervise({ statePath, runId, deadline, command, args });
