import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageBoardClient } from '../message-board/client';
import { parseBoardConfig } from '../message-board/config';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(join(tmpdir(), 'message-board-check-'));
const cli = process.env.SPACETIME_CLI ?? 'spacetime';
const env = { ...process.env, PATH: `${process.env.PATH ?? ''}:${join(homedir(), '.local', 'bin')}` };
const clients: MessageBoardClient[] = [];
const processes = new Set<ChildProcess>();
const cliArgs = ['--config-path', join(directory, 'cli.toml')];
let server: ChildProcess | undefined;
let output = '';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check: () => boolean | Promise<boolean>, label: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}\n${output.slice(-2000)}`);
    await delay(50);
  }
}
async function run(command: string, args: string[], quiet = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.add(child); let result = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000);
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', bytes => { if (!quiet) result += String(bytes); });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timeout); processes.delete(child);
      code === 0 ? resolve() : reject(new Error(`Check subprocess failed (${code}): ${result}`));
    });
  });
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await closed; clearTimeout(timer); processes.delete(child);
}
async function port(): Promise<number> {
  const listener = createServer();
  return new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('No test port');
      listener.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}
try {
  const testPort = await port(); const origin = `http://127.0.0.1:${testPort}`;
  const uri = `ws://127.0.0.1:${testPort}`;
  async function startServer() {
    server = spawn(cli, [...cliArgs, 'start', '--listen-addr', `127.0.0.1:${testPort}`, '--data-dir', join(directory, 'data'), '--non-interactive'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.add(server); let error: Error | undefined;
    server.once('error', reason => { error = reason; });
    for (const stream of [server.stdout!, server.stderr!]) stream.on('data', bytes => { output = (output + String(bytes)).slice(-4000); });
    await wait(async () => {
      if (error) throw error;
      if (server!.exitCode !== null) throw new Error('Test server exited');
      try { return (await fetch(`${origin}/v1/ping`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    }, 'server startup');
  }
  await startServer();
  const publisher = await (await fetch(`${origin}/v1/identity`, { method: 'POST' })).json() as { token: string };
  await run(cli, [...cliArgs, 'login', '--token', publisher.token], true);
  const publish = (module: string, database: string) => run(cli, [...cliArgs, 'publish', '--module-path', module, '--server', origin, '--no-config', '--yes', database]);
  await publish('message-board', 'board-one'); await publish('message-board', 'board-two');
  await publish('message-board', 'board-limited'); await publish('coord', 'board-development');
  function client(database: string, options: { historyWindowMs?: number; historyRefreshMs?: number } = {}) {
    const result = new MessageBoardClient({ uri, database, ...options }); clients.push(result); result.start(); return result;
  }
  const alice = client('board-one'), bob = client('board-one'), intruder = client('board-one');
  const other = client('board-two'), limited = client('board-limited'), dev = client('board-development'), devIntruder = client('board-development');
  await wait(() => clients.every(c => c.ready), 'all subscription snapshots');
  await alice.register('alice', 'valuation-analyst', 'Generic participant type');
  await bob.register('bob', 'miner', 'Another generic participant type');
  await intruder.register('mallory', 'miner');
  await other.register('alice', 'factory-planner');
  await dev.register('developer', 'codex');
  await devIntruder.register('remote', 'codex');
  await assert.rejects(intruder.register('alice', 'miner'), /another identity/);
  await assert.rejects(intruder.post('alice', 'Forged message'), /another identity/);
  await assert.rejects(intruder.createTask('alice', { id: 'forged', title: 'Forged task' }), /another identity/);
  await assert.rejects(intruder.reserve('alice', 'world/forged'), /another identity/);
  await assert.rejects(devIntruder.register('developer', 'codex'), /another identity/);
  await assert.rejects(devIntruder.post('developer', 'Forged development message'), /another identity/);
  await alice.bootstrapOperator();
  await dev.bootstrapOperator();
  await assert.rejects(intruder.bootstrapOperator(), /already configured/);
  await assert.rejects(intruder.setParticipantLimit(4), /Board operator identity required/);
  await assert.rejects(bob.cleanup('bob'), /operator identity required/);
  await assert.rejects(devIntruder.cleanup('remote'), /operator identity required/);
  await assert.rejects(intruder.assignSessionIdentity('alice', intruder.identity), /operator identity required/);
  await alice.assignSessionIdentity('alice', intruder.identity);
  await assert.rejects(alice.post('alice', 'Old token after operator recovery'), /another identity/);
  await intruder.register('alice', 'valuation-analyst');
  await alice.assignSessionIdentity('alice', alice.identity);
  await alice.register('alice', 'valuation-analyst');
  for (let index = 1; index <= 5; index++) await alice.register(`extra-${index}`, 'test-participant');
  await assert.rejects(alice.register('extra-6', 'test-participant'), /Participant limit reached \(8\/8\)/);
  assert.equal(alice.snapshot().participants.length, 8, 'default registration cap is eight and counts names even under one identity');
  await limited.bootstrapOperator();
  await limited.setParticipantLimit(2);
  await limited.register('limited-one', 'miner');
  await limited.register('limited-two', 'planner');
  await assert.rejects(limited.register('limited-three', 'scout'), /Participant limit reached \(2\/2\)/);
  await assert.rejects(limited.setParticipantLimit(1), /cannot be lower than the current participant count \(2\)/);
  assert.throws(() => limited.setParticipantLimit(9), /participantLimit must be an integer from 1 to 8/);
  assert.equal(limited.snapshot().participants.length, 2, 'hard registration cap is enforced in the reducer');
  console.log('PASS configurable hard participant cap, operator-only changes, and registration rejection');
  await alice.createTask('alice', { id: 'same-id', title: 'Independent task', details: 'No development instructions here.' });
  await other.createTask('alice', { id: 'same-id', title: 'Separate board task', priority: 'high' });
  await dev.createTask('developer', { id: 'same-id', title: 'Development task' });
  await assert.rejects(intruder.claimTask('alice', 'same-id'), /another identity/);
  await assert.rejects(intruder.setTaskPriority('alice', 'same-id', 'high'), /another identity/);
  await assert.rejects(intruder.updateTask('alice', 'same-id', 'cancelled'), /another identity/);
  await wait(() => dev.snapshot().tasks.length === 1 && other.snapshot().tasks.length === 1, 'task snapshots');
  assert.match(dev.snapshot().tasks[0].details, /push when finished/);
  assert.doesNotMatch(alice.snapshot().tasks[0].details, /push when finished/);
  assert.equal(alice.snapshot().tasks[0].priority, 'normal', 'existing tasks default to Normal');
  await bob.setTaskPriority('bob', 'same-id', 'urgent');
  await wait(() => alice.snapshot().tasks[0].priority === 'urgent', 'priority shared with another identity');
  assert.equal(other.snapshot().tasks[0].priority, 'high', 'bot-supplied creation priority is isolated by board');
  await assert.rejects(other.createTask('alice', { id: 'bad-priority', title: 'Must not be created', priority: 'invalid' as any }));
  assert.ok(!other.snapshot().tasks.some(t => t.id === 'bad-priority'));
  await assert.rejects(alice.setTaskPriority('unregistered', 'same-id', 'high'));
  await assert.rejects(alice.setTaskPriority('alice', 'missing-task', 'high'));
  await assert.rejects(alice.setTaskPriority('alice', 'same-id', 'invalid' as any));
  await dev.setTaskPriority('developer', 'same-id', 'low');
  await wait(() => dev.snapshot().tasks[0].priority === 'low', 'development priority');
  const claims = await Promise.allSettled([alice.claimTask('alice', 'same-id'), bob.claimTask('bob', 'same-id')]);
  assert.equal(claims.filter(c => c.status === 'fulfilled').length, 1, 'atomic claim has exactly one winner');
  await wait(() => alice.snapshot().tasks[0]?.status === 'claimed' && bob.snapshot().tasks[0]?.status === 'claimed', 'claim delivery');
  const winnerName = alice.snapshot().tasks[0].assignee; const winner = winnerName === 'alice' ? alice : bob;
  const loser = winnerName === 'alice' ? bob : alice; const loserName = winnerName === 'alice' ? 'bob' : 'alice';
  await winner.reserve(winnerName, 'world/chunks/', 'same-id');
  await assert.rejects(loser.reserve(loserName, 'world/chunks/0-0', 'same-id'));
  await assert.rejects(loser.updateTask(loserName, 'same-id', 'done', 'Cannot complete another participant task'));
  await alice.createTask('alice', { id: 'depends', title: 'Dependent task', dependsOn: 'same-id' });
  await assert.rejects(alice.claimTask('alice', 'depends'));
  await winner.updateTask(winnerName, 'same-id', 'done', 'Completed');
  await wait(() => alice.snapshot().reservations.length === 0, 'completion releases reservations');
  await alice.claimTask('alice', 'depends');
  await alice.post('alice', 'Shared only inside board one', 'bob', 'same-id');
  await wait(() => bob.snapshot().messages.length === 1, 'message live delivery');
  assert.equal(other.snapshot().messages.length, 0, 'message isolation');
  await assert.rejects(other.post('alice', 'Cross-board recipient must fail', 'bob'));
  assert.equal(other.snapshot().tasks[0].status, 'open', 'task isolation');
  const bounded = client('board-one', { historyWindowMs: 2000, historyRefreshMs: 100 });
  await wait(() => bounded.ready || bounded.state.startsWith('Connection unavailable'), 'bounded history subscription');
  assert.equal(bounded.ready, true, bounded.state);
  await alice.createTask('alice', { id: 'history-terminal', title: 'Expires from recent task view' });
  await alice.claimTask('alice', 'history-terminal');
  await alice.updateTask('alice', 'history-terminal', 'done');
  await alice.post('alice', 'Expires from recent message view', '', 'history-terminal');
  await alice.createTask('alice', { id: 'history-active', title: 'Old active task stays visible' });
  await alice.setTaskPriority('alice', 'history-active', 'urgent');
  await alice.reserve('alice', 'history/active', 'history-active');
  await wait(() => bounded.snapshot().tasks.some(task => task.id === 'history-terminal')
    && bounded.snapshot().tasks.some(task => task.id === 'history-active' && task.priority === 'urgent')
    && bounded.snapshot().messages.some(message => message.body === 'Expires from recent message view')
    && bounded.snapshot().reservations.some(lock => lock.path === 'history/active'), 'bounded history receives new rows');
  await wait(() => !bounded.snapshot().tasks.some(task => task.id === 'history-terminal')
    && !bounded.snapshot().messages.some(message => message.body === 'Expires from recent message view')
    && bounded.snapshot().tasks.some(task => task.id === 'history-active' && task.priority === 'urgent')
    && bounded.snapshot().reservations.some(lock => lock.path === 'history/active'), 'history window advances but keeps active task and lock', 15_000);
  await alice.setTaskPriority('alice', 'history-terminal', 'high');
  await wait(() => bounded.snapshot().tasks.some(task => task.id === 'history-terminal' && task.priority === 'high'), 'recent priority change brings its task back into view');
  await wait(() => !bounded.snapshot().tasks.some(task => task.id === 'history-terminal'), 'old task leaves after its priority update ages out', 15_000);
  console.log('PASS rolling history subscription drops expired terminal/message rows, shows recent priority changes and keeps active tasks/locks');
  const identity = alice.identity;
  alice.stop(); assert.equal(alice.snapshot().messages.length, 0, 'no stale disconnected snapshot');
  alice.start(); await wait(() => alice.ready && alice.snapshot().messages.some(message => message.body === 'Shared only inside board one')
    && alice.snapshot().messages.some(message => message.body === 'Expires from recent message view'), 'restart recovery');
  assert.equal(alice.identity, identity, 'restart retains identity');
  assert.equal(alice.snapshot().tasks.find(t => t.id === 'same-id')!.priority, 'urgent', 'priority survives reconnect');
  // Publishing the shared implementation again preserves compatible development history.
  await publish('coord', 'board-development');
  await wait(() => dev.ready && dev.snapshot().tasks.length === 1, 'development update preserves history');
  await stop(server); await wait(() => clients.every(c => !c.ready), 'disconnect detection');
  await startServer(); await wait(() => clients.every(c => c.ready), 'automatic reconnect', 40_000);
  assert.equal(alice.identity, identity); assert.equal(bob.snapshot().messages.length, 2);
  assert.equal(other.snapshot().messages.length, 0); assert.match(dev.snapshot().tasks[0].details, /push when finished/);
  assert.equal(dev.snapshot().tasks[0].priority, 'low', 'priority survives database restart and module republish');
  assert.equal(alice.snapshot().tasks[0].priority, 'urgent', 'urgent tasks sort before lower priorities');
  assert.equal(alice.snapshot().tasks.find(task => task.id === 'same-id')?.priority, 'urgent');
  const config = JSON.parse(readFileSync(join(root, 'message-board/instances.json'), 'utf8'));
  config.boards.push({ id: 'new-application', label: 'New application', database: 'new-board', modulePath: 'message-board' });
  assert.equal(parseBoardConfig(config).boards.length, 5, 'new application only needs configuration');
  assert.throws(() => parseBoardConfig({ ...config, defaultBoard: 'unknown' }));
  assert.throws(() => parseBoardConfig({ ...config, boards: [...config.boards, config.boards[0]] }));
  console.log('PASS: shared API, authenticated participant names, operator recovery and cleanup, cross-board isolation, atomic claims, dependency checks, reservations, development-only policy, history preservation, identity recovery, automatic reconnect, extensible configuration.');
} finally {
  clients.forEach(client => client.stop());
  await Promise.all([...processes].map(stop));
  rmSync(directory, { recursive: true, force: true });
}
