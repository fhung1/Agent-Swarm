import { createHash } from 'node:crypto';
import { recordId } from './ids.ts';
import type { SwarmConfig } from './swarm-plan.ts';

export interface ScheduleTask {
  id: string; status: string; kind: string; objective: string; symbol: string; result: string;
}
export interface ScheduleSnapshot {
  nowMs: number;
  run: { status: string; createdAtMs: number };
  tasks: ScheduleTask[];
  decisions: { thesisId: string }[];
  budget?: { usedInferences: number; maxInferences: number; usedTokens: number; maxTokens: number };
}
export interface ScheduledTask {
  id: string; runId: string; symbol: string; kind: 'thesis'; objective: string; role: 'analyst'; dependsOn: '';
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Namespace is stable across cadence edits, so existing task rows can detect an incompatible config.
export function schedulePrefix(runId: string): string { return `cycle.${digest(runId).slice(0, 24)}.`; }

export function planResearchCycle(config: SwarmConfig, state: ScheduleSnapshot): { reason: string; tasks: ScheduledTask[] } {
  const research = config.research;
  if (!research?.schedule) throw new Error('No research schedule configured');
  const schedule = research.schedule;
  const prefix = schedulePrefix(config.runId);
  const marker = `Research schedule v1: ${digest({ ...research, symbols: [...research.symbols].sort() })}`;
  const cycles = new Map<number, ScheduleTask[]>();
  for (const task of state.tasks.filter(t => t.kind === 'thesis' && t.id.startsWith(prefix))) {
    const match = /^(\d+)\.([A-Z][A-Z0-9.-]*)$/.exec(task.id.slice(prefix.length));
    if (!match || !task.objective.endsWith(`\n${marker}`)) throw new Error('Existing research schedule differs from configuration');
    const cycle = Number(match[1]);
    if (!Number.isSafeInteger(cycle) || cycle >= schedule.maxCycles || !research.symbols.includes(task.symbol) || match[2] !== task.symbol) {
      throw new Error('Invalid durable scheduled task');
    }
    cycles.set(cycle, [...(cycles.get(cycle) ?? []), task]);
  }
  const idle = (reason: string) => ({ reason, tasks: [] });
  if (state.run.status !== 'active') return idle(`run ${state.run.status}`);
  if (!state.budget) return idle('durable run budget unavailable');
  if (!Object.values(state.budget).every(n => Number.isSafeInteger(n) && n >= 0) ||
      !state.budget.maxInferences || !state.budget.maxTokens) return idle('invalid durable run budget');
  if (state.budget.usedInferences >= state.budget.maxInferences || state.budget.usedTokens >= state.budget.maxTokens) {
    return idle('durable run budget exhausted');
  }
  if (![state.nowMs, state.run.createdAtMs].every(Number.isFinite)) throw new Error('Invalid scheduler clock');
  if (state.nowMs < state.run.createdAtMs) return idle('run starts in the future');
  const current = Math.floor((state.nowMs - state.run.createdAtMs) / (schedule.everySeconds * 1000));
  // Resume a partly published batch before admitting a new one. The task rows are the journal.
  const partial = [...cycles].filter(([, tasks]) => tasks.length < research.symbols.length).map(([n]) => n).sort((a, b) => a - b)[0];
  const cycle = partial ?? current;
  if (cycle >= schedule.maxCycles) return idle('cadence window budget exhausted');
  const existing = new Set(state.tasks.map(t => t.id));
  const missing = research.symbols.filter(symbol => !existing.has(`${prefix}${cycle}.${symbol}`));
  if (!missing.length) return idle('cycle already published');
  const decided = new Set(state.decisions.map(d => d.thesisId));
  const finished = (task: ScheduleTask) => task.status === 'failed' ||
    (task.status === 'completed' && decided.has(task.result || recordId('thesis.', task.id)));
  const pending = [...cycles].filter(([n, tasks]) => n !== cycle && tasks.some(t => !finished(t))).length;
  // Existing one-shot/manual research counts as one competing batch until its decision is durable.
  const legacyPending = state.tasks.some(t => t.kind === 'thesis' && !t.id.startsWith(prefix) && !finished(t)) ? 1 : 0;
  if (pending + legacyPending >= schedule.maxPendingCycles) return idle('pending cycle limit reached');
  return {
    reason: `cycle ${cycle}`,
    tasks: missing.map(symbol => ({ id: `${prefix}${cycle}.${symbol}`, runId: config.runId, symbol,
      kind: 'thesis', objective: `${research.objective}\n${marker}`, role: 'analyst', dependsOn: '' })),
  };
}

export interface SchedulePort {
  snapshot(): ScheduleSnapshot;
  ingest(symbol: string): Promise<boolean>;
  create(task: ScheduledTask): void;
  stopped(): boolean;
}

// Serial delivery; the Linux supervisor lock prevents two local schedulers from admitting separate batches.
// create_task is idempotent and enforces active-run state transactionally after this client-side check.
export async function deliverResearchCycle(config: SwarmConfig, port: SchedulePort): Promise<string[]> {
  const candidates = planResearchCycle(config, port.snapshot()).tasks;
  const queued: string[] = [];
  for (const task of candidates) {
    if (port.stopped()) break;
    if (!planResearchCycle(config, port.snapshot()).tasks.some(t => t.id === task.id)) continue;
    if (!await port.ingest(task.symbol)) continue;
    if (port.stopped()) break;
    if (!planResearchCycle(config, port.snapshot()).tasks.some(t => t.id === task.id)) continue;
    port.create(task);
    queued.push(task.id);
  }
  return queued;
}
