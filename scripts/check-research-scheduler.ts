#!/usr/bin/env node
// Node 24+. Real disposable database + fixture/rules workers; virtual cadence clock, no SEC/model/broker calls.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { parseSwarmConfig } from '../src/swarm-plan.ts';
import { deliverResearchCycle, planResearchCycle, type ScheduleSnapshot, type ScheduledTask, type SchedulePort } from '../src/research-schedule.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(join(tmpdir(), 'research-scheduler-check-'));
const database = `research-scheduler-check-${randomUUID().slice(0, 8)}`;
const runId = 'scheduled-acceptance';
const env = { ...process.env, PATH: `${process.env.PATH ?? ''}:${join(homedir(), '.local', 'bin')}` };
const cli = process.env.SPACETIME_CLI ?? 'spacetime';
const children: ChildProcess[] = [];
let published = false, passed = false, clockOffset = 1000, ingestions = 0;
const config = parseSwarmConfig(JSON.stringify({ runId, agents: {},
  limits: { maxInferences: 20, maxTokens: 10000, maxConcurrent: 2, maxAttempts: 2 },
  research: { symbols: ['AAPL'], evidence: 'fixture', schedule: { everySeconds: 60, maxCycles: 3 } } }));
const command = (args: string[]) => execFileSync(cli, args, { cwd: root, env, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
function call(reducer: string, values: unknown[]) {
  command(['call', '--server', 'local', database, reducer, ...values.map(v => JSON.stringify(v))]);
}
type Row = Record<string, unknown>;
function rows() {
  const out = command(['subscribe', '--server', 'local', database, 'SELECT * FROM run', 'SELECT * FROM task',
    'SELECT * FROM decision', 'SELECT * FROM run_config', 'SELECT * FROM source', 'SELECT * FROM fact',
    '--print-initial-update', '-n', '0', '--yes']);
  const update = JSON.parse(out.split('\n').find(line => line.startsWith('{'))!) as Record<string, { inserts: Row[] }>;
  return Object.fromEntries(['run', 'task', 'decision', 'run_config', 'source', 'fact'].map(name => [name, update[name]?.inserts ?? []]));
}
function snapshot(): ScheduleSnapshot {
  const r = rows(), run = r.run[0], b = r.run_config[0];
  const createdAtMs = Number((run.created_at as { __timestamp_micros_since_unix_epoch__: number }).__timestamp_micros_since_unix_epoch__) / 1000;
  return { nowMs: createdAtMs + clockOffset, run: { status: String(run.status), createdAtMs },
    tasks: r.task.map(t => ({ id: String(t.id), kind: String(t.kind), status: String(t.status),
      objective: String(t.objective), symbol: String(t.symbol), result: String(t.result) })),
    decisions: r.decision.map(d => ({ thesisId: String(d.thesis_id) })),
    budget: { usedInferences: Number(b.used_inferences), maxInferences: Number(b.max_inferences),
      usedTokens: Number(b.used_tokens), maxTokens: Number(b.max_tokens) } };
}
const create = (t: ScheduledTask) => call('create_task', [t.id, t.runId, t.symbol, t.kind, t.objective, t.role, t.dependsOn]);
const childEnv = (token: string) => ({ PATH: env.PATH, SPACETIMEDB_HOST: 'ws://127.0.0.1:3000', SPACETIMEDB_DB_NAME: database,
  RUN_ID: runId, SPACETIMEDB_TOKEN_FILE: token, AGENT_TOKEN_FILE: token, AGENT_BRAIN: 'rules', AUTO_CLAIM: '1', WORK_DELAY_MS: '0' });
function identity(tokenFile: string) {
  const token = readFileSync(tokenFile, 'utf8').trim();
  const id = (JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { hex_identity: string }).hex_identity;
  assert.match(id, /^[0-9a-f]{64}$/);
  return id;
}
function worker(role: string, token: string) {
  const fd = openSync(join(directory, `${role}.log`), 'a', 0o600);
  const child = spawn(process.execPath, [join(directory, 'worker.mjs')], { env: childEnv(token), stdio: ['ignore', fd, fd] });
  closeSync(fd); children.push(child); return child;
}
async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 45000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(r => setTimeout(r, 200));
  }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'close');
  child.kill('SIGINT');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await exited; clearTimeout(timer);
}

async function verifyLocalLock() {
  const lock = join(directory, 'supervisor.lock');
  const holder = spawn('flock', ['-n', '-E', '75', lock, process.execPath, '-e',
    'process.stdout.write("locked"); setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise<void>(resolve => holder.once('close', () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await new Promise<string>((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout!.once('data', data => resolve(String(data)));
      holder.once('exit', code => { if (code) reject(new Error(`Lock holder exited ${code}`)); });
      timer = setTimeout(() => reject(new Error('Lock holder did not become ready')), 10000);
    });
    assert.equal(ready, 'locked');
    assert.throws(() => execFileSync('flock', ['-n', '-E', '75', lock, 'true'], { stdio: 'pipe' }),
      (error: unknown) => (error as { status?: number }).status === 75);
  } finally {
    clearTimeout(timer);
    try { process.kill(-holder.pid!, 'SIGKILL'); } catch { /* already exited */ }
    await closed;
  }
  execFileSync('flock', ['-n', '-E', '75', lock, 'true'], { stdio: 'pipe' }); // Crash released ownership.
}

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node 24 or newer');
  if (process.platform !== 'linux') throw new Error('Scheduler acceptance requires Linux with util-linux flock');
  await verifyLocalLock();
  // Read committed module source, never build another session's unfinished module/schema edits.
  const archive = execFileSync('git', ['archive', 'HEAD', 'spacetimedb'], { cwd: root });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  command(['publish', '--module-path', join(directory, 'spacetimedb'), '--server', 'local', database, '--yes', '--no-config']);
  published = true;
  const owner = /logged in as ([0-9a-f]{64})/.exec(command(['login', 'show']))?.[1];
  assert.ok(owner, 'CLI identity required');
  call('grant_agent', [owner, 'operator']); call('create_run', [runId, 'Disposable research scheduler fixture acceptance']);
  call('configure_run_limits', [runId, 20, 10000, 2, 2]);
  execFileSync(join(root, 'node_modules/.bin/esbuild'), ['src/worker.ts', 'src/fixture-ingestor.ts', '--bundle', '--platform=node',
    '--format=esm', `--outdir=${directory}`, '--out-extension:.js=.mjs'], { cwd: root, stdio: 'pipe' });
  const fixtureToken = join(directory, 'fixture.token');
  execFileSync(process.execPath, [join(directory, 'fixture-ingestor.mjs'), '--register'], { env: childEnv(fixtureToken), timeout: 20000, stdio: 'pipe' });
  call('grant_agent', [identity(fixtureToken), 'ingestor']); call('grant_run_access', [identity(fixtureToken), runId]);
  for (const role of ['analyst', 'skeptic', 'coordinator']) {
    const token = join(directory, `${role}.token`);
    const registering = worker(role, token);
    await waitFor(() => { try { identity(token); return true; } catch { return false; } }, `${role} token registration`);
    await stop(registering);
    call('grant_agent', [identity(token), role]); call('grant_run_access', [identity(token), runId]);
    worker(role, token);
  }
  const port = (): SchedulePort => ({ snapshot, stopped: () => false, create,
    ingest: async symbol => {
      ingestions++;
      execFileSync(process.execPath, [join(directory, 'fixture-ingestor.mjs')],
        { env: { ...childEnv(fixtureToken), SYMBOL: symbol }, timeout: 20000, stdio: 'pipe' });
      const r = rows();
      assert.equal(r.source.filter(s => s.symbol === symbol && s.kind === 'fixture').length, 2);
      assert.equal(r.fact.filter(f => f.symbol === symbol && f.quality === 'fixture').length, 2);
      return true;
    } });
  const firstTask = planResearchCycle(config, snapshot()).tasks[0];
  const first = await deliverResearchCycle(config, port());
  assert.equal(first.length, 1);
  create(firstTask); // Same reducer delivery, actual idempotent DB retry.
  await waitFor(() => rows().decision.length === 1, 'first thesis -> skeptic review -> coordinator decision');
  assert.deepEqual(await deliverResearchCycle(config, port()), []);
  assert.equal(ingestions, 1);

  clockOffset = 60001;
  const secondTask = planResearchCycle(config, snapshot()).tasks[0];
  call('set_run_status', [runId, 'paused']);
  assert.deepEqual(await deliverResearchCycle(config, port()), []);
  assert.equal(ingestions, 1);
  assert.throws(() => create(secondTask), /not active|paused/); // Authoritative last-moment gate, not just a local snapshot.
  call('set_run_status', [runId, 'active']);
  const second = await deliverResearchCycle(config, port());
  assert.equal(second.length, 1); assert.notEqual(first[0], second[0]);
  await waitFor(() => rows().decision.length === 2, 'second sourced decision');
  assert.deepEqual(await deliverResearchCycle(config, port()), []); // New adapter, existing durable state: restart reconciliation.
  const result = rows();
  assert.equal(result.task.filter(t => t.kind === 'thesis').length, 2);
  assert.equal(result.task.filter(t => t.kind === 'review' && t.status === 'completed').length, 2);
  assert.equal(result.decision.length, 2); assert.equal(result.source.length, 2); assert.equal(ingestions, 2);
  passed = true;
  console.log('PASS: two real sourced cycles, skeptic dependencies/coordinator decisions, idempotent replay/restart, pause rejection/resume and local lock contention/crash release. Cadence clock virtual; fixtures/rules only; no broker/model/SEC calls.');
} finally {
  await Promise.all(children.map(stop));
  if (published) command(['delete', '--server', 'local', database, '--yes', '--no-config']);
  if (passed) rmSync(directory, { recursive: true });
  else console.error(`Failure artifacts retained at ${directory}; temporary database removed.`);
}
