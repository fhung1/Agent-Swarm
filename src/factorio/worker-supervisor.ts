import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

export const RETRYABLE_BOARD_OUTAGE = 75;
export const UNKNOWN_GAME_OUTCOME = 78;
export interface RestartState { version: 1; runId: string; attempts: number; deadline: number; quarantined: boolean }
export function restartDelay(state: RestartState, exitCode: number | null, now: number, maximum = 8): number | null {
  if (state.quarantined || exitCode !== RETRYABLE_BOARD_OUTAGE || state.attempts >= maximum || now >= state.deadline) return null;
  const delay = Math.min(30_000, 1_000 * 2 ** state.attempts);
  return now + delay < state.deadline ? delay : null;
}
export function saveRestartState(path: string, state: RestartState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
export function loadRestartState(path: string, runId: string, deadline: number): RestartState {
  let parsed: RestartState;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { version: 1, runId, attempts: 0, deadline, quarantined: false };
  }
  if (parsed.version !== 1 || parsed.runId !== runId || parsed.deadline !== deadline ||
      !Number.isSafeInteger(parsed.attempts) || parsed.attempts < 0 || typeof parsed.quarantined !== 'boolean') {
    throw Error('Foreign or invalid supervisor state');
  }
  return parsed;
}
/** Workers explicitly classify board outages as 75. Unknown outcomes (78), signals,
 * and other failures stop supervision. Restarts preserve all worker arguments and
 * journals; the worker must reconcile ownership and receipts before acting.
 */
export async function supervise(options: { statePath: string; runId: string; deadline: number; command: string; args: string[] }): Promise<number> {
  const state = loadRestartState(options.statePath, options.runId, options.deadline);
  saveRestartState(options.statePath, state);
  let stopped = false;
  let child: ReturnType<typeof spawn> | undefined;
  let cancelWait: (() => void) | undefined;
  const stop = () => { stopped = true; child?.kill('SIGTERM'); cancelWait?.(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const deadlineTimer = setTimeout(stop, Math.max(0, Math.min(2_147_483_647, state.deadline - Date.now())));
  try {
    while (!stopped && Date.now() < state.deadline && !state.quarantined) {
      const code = await new Promise<number | null>((resolve, reject) => {
        child = spawn(options.command, options.args, { stdio: 'inherit' });
        child.once('error', reject); child.once('exit', resolve);
      });
      child = undefined;
      if (stopped) return 0;
      if (code === UNKNOWN_GAME_OUTCOME) { state.quarantined = true; saveRestartState(options.statePath, state); }
      const delay = restartDelay(state, code, Date.now());
      if (delay === null) return code ?? 1;
      // Persist the charged attempt before waiting/spawning, including supervisor restart.
      state.attempts++; saveRestartState(options.statePath, state);
      console.error(`Board outage: worker restart ${state.attempts}/8 in ${delay}ms`);
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { cancelWait = undefined; resolve(); }, delay);
        cancelWait = () => { clearTimeout(timer); cancelWait = undefined; resolve(); };
      });
    }
    return state.quarantined ? UNKNOWN_GAME_OUTCOME : 0;
  } finally {
    clearTimeout(deadlineTimer); process.off('SIGTERM', stop); process.off('SIGINT', stop);
  }
}
