import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFilingExcerptArtifacts } from '../src/sec-excerpts.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(join(tmpdir(), 'sec-ingest-check-'));
const replay = resolve(process.argv[2] ?? join(homedir(), '.local/share/quant-swarm/artifacts/sec'));
const cli = process.env.SPACETIME_CLI ?? 'spacetime';
const config = join(directory, 'cli.toml');
const cliArgs = ['--config-path', config];
const children = new Set<ChildProcess>();
let server: ChildProcess | undefined;
let serverLog = '';
const env = { ...process.env, SEC_REPLAY_DIR: replay, SEC_USER_AGENT: 'Offline fixture replay test@example.com',
  RUN_ID: 'sec-excerpt-replay', SYMBOLS: 'AAPL,MSFT', SPACETIMEDB_DB_NAME: 'sec-excerpt-replay',
  SPACETIMEDB_TOKEN_FILE: join(directory, 'ingestor.token'), SEC_ARTIFACT_DIR: join(directory, 'artifacts'),
  SEC_CACHE_DIR: join(directory, 'cache'), PATH: `${process.env.PATH ?? ''}:${join(homedir(), '.local/bin')}` };

async function run(executable: string, args: string[], succeeds = true, extra = {}): Promise<string> {
  return await new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', chunk => { output += String(chunk); });
    child.once('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); children.delete(child);
      if ((code === 0) === succeeds) done(output);
      else reject(new Error(`${executable} ${succeeds ? 'failed' : 'unexpectedly succeeded'}: ${output.slice(-3000)}`));
    });
  });
}

async function port(): Promise<number> {
  return await new Promise((done, reject) => {
    const socket = createServer(); socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const address = socket.address(); assert(address && typeof address !== 'string');
      socket.close(error => error ? reject(error) : done(address.port)); });
  });
}

function killServer(signal: NodeJS.Signals): void {
  if (server?.pid) try { process.kill(-server.pid, signal); } catch { /* Already stopped. */ }
}

async function main(): Promise<void> {
  assert.match(await run(cli, ['--version']), /spacetimedb tool version 2\.10\.2;/);
  // Committed module, temporary CLI config and server; concurrent module edits are not used.
  const archive = join(directory, 'module.tar');
  await run('git', ['archive', 'HEAD', 'spacetimedb', '--output', archive]);
  await run('tar', ['-xf', archive, '-C', directory]);
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const keys = join(directory, 'keys'); mkdirSync(keys);
  await run('openssl', ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-out', join(keys, 'private')]);
  await run('openssl', ['ec', '-in', join(keys, 'private'), '-pubout', '-out', join(keys, 'public')]);
  const number = await port(); const origin = `http://127.0.0.1:${number}`;
  Object.assign(env, { SPACETIMEDB_HOST: `ws://127.0.0.1:${number}` });
  server = spawn(cli, [...cliArgs, 'start', '--non-interactive', '--listen-addr', `127.0.0.1:${number}`, '--data-dir',
    join(directory, 'data'), '--jwt-priv-key-path', join(keys, 'private'), '--jwt-pub-key-path', join(keys, 'public')],
  { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let startupError: Error | undefined; server.once('error', error => { startupError = error; });
  for (const stream of [server.stdout!, server.stderr!]) stream.on('data', chunk => { serverLog = (serverLog + String(chunk)).slice(-4000); });
  let ready = false;
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    if (startupError || server.exitCode !== null || server.signalCode !== null) throw new Error(`Server failed: ${startupError ?? serverLog}`);
    try { if ((await fetch(`${origin}/v1/ping`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch { /* Starting. */ }
    await new Promise(done => setTimeout(done, 100));
  }
  assert(ready, 'Temporary server startup timed out');
  const response = await fetch(`${origin}/v1/identity`, { method: 'POST' }); assert(response.ok);
  const owner = await response.json() as { identity: string; token: string };
  await run(cli, [...cliArgs, 'login', '--token', owner.token]);
  await run(cli, [...cliArgs, 'publish', '--module-path', join(directory, 'spacetimedb'), '--server', origin, '--no-config', '--yes', env.SPACETIMEDB_DB_NAME]);
  const call = (...args: string[]) => run(cli, [...cliArgs, 'call', '--server', origin, '--no-config', env.SPACETIMEDB_DB_NAME, ...args]);
  await call('grant_agent', owner.identity, 'operator');
  await call('create_run', env.RUN_ID, 'Real saved SEC artifact replay; no live SEC/model/broker calls');
  const nodeArgs = ['--import', join(root, 'scripts/mock-sec-fetch.mjs'), join(root, 'dist/sec-ingestor.js')];
  const registered = await run(process.execPath, [...nodeArgs, '--register']);
  const identity = /Connected to SpacetimeDB as ([0-9a-f]+)/.exec(registered)?.[1]; assert(identity);
  await call('grant_agent', identity, 'ingestor'); await call('grant_run_access', identity, env.RUN_ID);
  const table = async (name: string) => {
    const output = await run(cli, [...cliArgs, 'sql', '--server', origin, '--no-config', '--format', 'json', env.SPACETIMEDB_DB_NAME, `SELECT * FROM ${name}`]);
    const parsed = JSON.parse(output.slice(output.indexOf('[{')))[0];
    const columns = parsed.schema.elements.map((column: { name: { some: string } }) => column.name.some);
    return parsed.rows.map((row: unknown[]) => Object.fromEntries(columns.map((name: string, index: number) => [name, row[index]]))) as Record<string, any>[];
  };
  // Interrupt after AAPL to prove resumption preserves already committed sources and facts.
  assert.match(await run(process.execPath, nodeArgs, false, { SEC_REPLAY_FAIL_MSFT: '1' }), /403/);
  assert.equal((await table('source')).length, 2);
  await run(process.execPath, nodeArgs);
  const sources = await table('source'); const facts = await table('fact');
  assert.equal(sources.length, 4);
  for (const source of sources) {
    const chunks = facts.filter(fact => fact.source_id === source.id && fact.metric.startsWith('excerpt.'));
    assert.equal(chunks.length, 4);
    assert.equal(new Set(chunks.map(row => row.id)).size, 4);
    const artifact = fileURLToPath(source.artifact_ref);
    const checked = verifyFilingExcerptArtifacts(env.SEC_ARTIFACT_DIR, artifact);
    assert.equal(checked.sections, 2); assert.equal(checked.chunks, 4);
    const manifest = JSON.parse(readFileSync(artifact, 'utf8'));
    for (const fact of chunks) {
      assert(fact.value.length <= 240 && fact.unit === 'text');
      assert.equal(fact.period, manifest.reportDate);
      assert(manifest.qualitativeExcerpts.chunks.some((row: { id: string }) => row.id === fact.id));
    }
  }
  await run(process.execPath, nodeArgs);
  assert.deepEqual((await table('source')).sort((a,b)=>a.id.localeCompare(b.id)), sources.sort((a,b)=>a.id.localeCompare(b.id)));
  assert.deepEqual((await table('fact')).sort((a,b)=>a.id.localeCompare(b.id)), facts.sort((a,b)=>a.id.localeCompare(b.id)));
  assert.equal(readdirSync(env.SEC_ARTIFACT_DIR).filter(name=>name.endsWith('.manifest.json')).length,4);
  console.log(`PASS: 4 real AAPL/MSFT filing sources, ${facts.length} facts including 16 excerpt chunks; verified offsets, partial-ingest recovery and duplicate-free rerun on an isolated database.`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { for (const child of children) child.kill('SIGTERM'); killServer('SIGTERM'); });
try { await main(); }
catch (error) { console.error(String(error)); process.exitCode = 1; }
finally {
  for (const child of children) child.kill('SIGKILL');
  if (server) {
    const child = server;
    const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(done => child.once('close', () => done()));
    killServer('SIGTERM'); const force = setTimeout(() => killServer('SIGKILL'), 5000);
    await closed; clearTimeout(force); killServer('SIGKILL');
  }
  rmSync(directory, { recursive: true, force: true });
}
