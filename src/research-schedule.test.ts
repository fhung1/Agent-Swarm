import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSwarmConfig } from './swarm-plan.ts';
import { deliverResearchCycle, planResearchCycle, type ScheduleSnapshot, type SchedulePort } from './research-schedule.ts';
import { recordId } from './ids.ts';

function config(symbols = ['AAPL'], maxPendingCycles = 1) {
  return parseSwarmConfig(JSON.stringify({ runId: 'scheduled-test', agents: {},
    limits: { maxInferences: 20, maxTokens: 10000, maxConcurrent: 2, maxAttempts: 2 },
    research: { symbols, evidence: 'fixture', schedule: { everySeconds: 60, maxCycles: 10, maxPendingCycles } } }));
}
function state(): ScheduleSnapshot {
  return { nowMs: 1000, run: { status: 'active', createdAtMs: 0 }, tasks: [], decisions: [],
    budget: { usedInferences: 0, maxInferences: 20, usedTokens: 0, maxTokens: 10000 } };
}
function port(s: ScheduleSnapshot, log: string[]): SchedulePort {
  return {
    snapshot: () => structuredClone(s), stopped: () => false,
    ingest: async symbol => { log.push(`ingest:${symbol}`); return true; },
    create: task => {
      log.push(`create:${task.symbol}`);
      const existing = s.tasks.find(t => t.id === task.id);
      if (existing) assert.equal(existing.objective, task.objective);
      else s.tasks.push({ ...task, status: 'open', result: '' });
    },
  };
}
function finish(s: ScheduleSnapshot) {
  for (const t of s.tasks) {
    t.status = 'completed'; t.result = recordId('thesis.', t.id);
    s.decisions.push({ thesisId: t.result });
  }
}

test('two cadence windows refresh each symbol before distinct tasks; restart and repeated delivery preserve IDs', async () => {
  const c = config(['AAPL', 'MSFT']), s = state(), log: string[] = [];
  assert.ok(planResearchCycle(c, s).tasks.every(t => t.role === 'analyst'));
  const first = await deliverResearchCycle(c, port(s, log));
  assert.equal(first.length, 2);
  assert.deepEqual(log, ['ingest:AAPL', 'create:AAPL', 'ingest:MSFT', 'create:MSFT']);
  assert.deepEqual(await deliverResearchCycle(c, port(s, log)), []);
  assert.equal(log.length, 4);
  finish(s); s.nowMs = 60001;
  const second = await deliverResearchCycle(c, port(s, log));
  assert.equal(second.length, 2);
  assert.equal(new Set([...first, ...second]).size, 4);
  assert.ok(s.tasks.every(t => t.kind === 'thesis'));
  assert.equal(log.length, 8);
  assert.deepEqual(await deliverResearchCycle(c, port(structuredClone(s), log)), []);
});

test('pending limit includes completed theses until coordinator decisions exist', () => {
  const c = config(), s = state();
  s.tasks.push({ ...planResearchCycle(c, s).tasks[0], status: 'completed', result: 'thesis-id' });
  s.nowMs = 60001;
  assert.match(planResearchCycle(c, s).reason, /pending cycle/);
  s.decisions.push({ thesisId: 'thesis-id' });
  assert.equal(planResearchCycle(c, s).tasks.length, 1);
});

test('pause and budget exhaustion during ingestion prevent publishing; resume refreshes again', async () => {
  const c = config(), s = state(), log: string[] = [], p = port(s, log);
  p.ingest = async () => { s.run.status = 'paused'; return true; };
  assert.deepEqual(await deliverResearchCycle(c, p), []);
  assert.equal(s.tasks.length, 0);
  s.run.status = 'active';
  p.ingest = async () => { s.budget!.usedTokens = s.budget!.maxTokens; return true; };
  assert.deepEqual(await deliverResearchCycle(c, p), []);
  assert.equal(s.tasks.length, 0);
  s.budget!.usedTokens = 0;
  assert.equal((await deliverResearchCycle(c, port(s, log))).length, 1);
  assert.deepEqual(log, ['ingest:AAPL', 'create:AAPL']);
});

test('paused/closed/missing-budget/exhausted-budget runs perform no evidence work', async () => {
  for (const mode of ['paused', 'closed', 'missing', 'tokens', 'inferences']) {
    const s = state(), log: string[] = [];
    if (mode === 'missing') s.budget = undefined;
    else if (mode === 'tokens') s.budget!.usedTokens = s.budget!.maxTokens;
    else if (mode === 'inferences') s.budget!.usedInferences = s.budget!.maxInferences;
    else s.run.status = mode;
    assert.deepEqual(await deliverResearchCycle(config(), port(s, log)), []);
    assert.deepEqual(log, []);
  }
});

test('restart resumes partly published cycles even after their cadence window budget ends', async () => {
  const c = config(['AAPL', 'MSFT']), s = state(), log: string[] = [], p = port(s, log);
  p.ingest = async symbol => symbol === 'AAPL';
  assert.equal((await deliverResearchCycle(c, p)).length, 1);
  s.nowMs = 600000;
  const resumed = await deliverResearchCycle(c, port(s, log));
  assert.equal(resumed.length, 1);
  assert.ok(resumed[0].endsWith('.0.MSFT'));
  assert.equal(planResearchCycle(c, s).tasks.length, 0);
});

test('uncertain successful create is reconciled from durable task rows without re-ingesting or duplicating', async () => {
  const c = config(), s = state(), log: string[] = [], p = port(s, log), create = p.create;
  p.create = t => { create(t); throw new Error('transport lost after commit'); };
  await assert.rejects(deliverResearchCycle(c, p), /transport lost/);
  assert.equal(s.tasks.length, 1);
  assert.deepEqual(await deliverResearchCycle(c, port(s, log)), []);
  assert.equal(log.length, 2);
});

test('failed ingestion and shutdown never publish fabricated sourced tasks', async () => {
  const c = config(), s = state(), log: string[] = [], p = port(s, log);
  p.ingest = async () => false;
  assert.deepEqual(await deliverResearchCycle(c, p), []);
  let stopped = false;
  p.stopped = () => stopped;
  p.ingest = async () => { stopped = true; return true; };
  assert.deepEqual(await deliverResearchCycle(c, p), []);
  assert.equal(s.tasks.length, 0);
});

test('configuration drift is rejected against the durable objective fingerprint', async () => {
  const c = config(), s = state();
  await deliverResearchCycle(c, port(s, []));
  const changed = structuredClone(c);
  changed.research!.schedule!.everySeconds = 120;
  assert.throws(() => planResearchCycle(changed, s), /differs from configuration/);
});

test('missed windows are skipped, cycle budget is bounded and legacy research counts toward overlap', () => {
  const c = config(), s = state();
  s.nowMs = 300001;
  assert.ok(planResearchCycle(c, s).tasks[0].id.endsWith('.5.AAPL'));
  s.nowMs = 600001;
  assert.match(planResearchCycle(c, s).reason, /window budget/);
  s.nowMs = 60001;
  s.tasks.push({ id: 'legacy-thesis', status: 'claimed', kind: 'thesis', objective: '', symbol: 'AAPL', result: '' });
  assert.match(planResearchCycle(c, s).reason, /pending cycle/);
});

test('cycle overlap cap permits two batches but blocks a third; failed thesis releases its slot', async () => {
  const c = config(['AAPL'], 2), s = state();
  await deliverResearchCycle(c, port(s, []));
  s.nowMs = 60001; await deliverResearchCycle(c, port(s, []));
  s.nowMs = 120001;
  assert.match(planResearchCycle(c, s).reason, /pending cycle/);
  s.tasks[0].status = 'failed';
  assert.equal(planResearchCycle(c, s).tasks.length, 1);
});

test('schedule configuration requires sourced evidence, workers, explicit budgets and valid bounds', () => {
  const c = config();
  for (const bad of [
    { ...c, limits: undefined },
    { ...c, research: { ...c.research, evidence: 'none' } },
    { ...c, research: { ...c.research, symbols: ['AAPL', 'AAPL'] } },
    { ...c, agents: { ...c.agents, skeptic: { count: 0 } } },
    { ...c, research: { ...c.research, schedule: { everySeconds: 0, maxCycles: 1 } } },
  ]) assert.throws(() => parseSwarmConfig(JSON.stringify(bad)));
});
