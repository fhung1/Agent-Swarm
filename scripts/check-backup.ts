import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pin committed module code so concurrent schema edits cannot affect this recovery drill.
// All identities, JWT keys, databases and files are temporary; no broker/model calls.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'quant-backup-drill-'));
chmodSync(dir, 0o700);
const env = { ...process.env, PATH: `${process.env.PATH ?? ''}:${join(homedir(), '.local', 'bin')}` };
const cli = process.env.SPACETIME_CLI ?? 'spacetime';
const config = join(dir, 'cli.toml');
const database = 'quant-backup-drill';
const children = new Set<ChildProcess>();
let server: ChildProcess | undefined;
let serverLog = '';
let stopped = false;

async function command(executable: string, args: string[], success = true): Promise<string> {
  if (stopped) throw new Error('Drill interrupted');
  return await new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', chunk => { output += String(chunk); });
    child.once('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); children.delete(child);
      if ((code === 0) === success) done(output);
      else reject(new Error(`${executable} ${success ? 'failed' : 'unexpectedly succeeded'}: ${output.slice(-4000)}`));
    });
  });
}

async function port(): Promise<number> {
  return await new Promise((done, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      assert(address && typeof address !== 'string');
      socket.close(error => error ? reject(error) : done(address.port));
    });
  });
}

function killServer(signal: NodeJS.Signals): void {
  if (server?.pid) try { process.kill(-server.pid, signal); } catch { /* Already exited. */ }
}

async function stopServer(): Promise<void> {
  if (!server) return;
  const child = server;
  const closed = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve() : new Promise<void>(done => child.once('close', () => done()));
  killServer('SIGTERM');
  const force = setTimeout(() => killServer('SIGKILL'), 5000);
  await closed;
  clearTimeout(force);
  killServer('SIGKILL');
  server = undefined;
}

async function start(data: string, keys: string): Promise<string> {
  const number = await port();
  const origin = `http://127.0.0.1:${number}`;
  serverLog = '';
  server = spawn(cli, ['--config-path', config, 'start', '--non-interactive', '--listen-addr', `127.0.0.1:${number}`,
    '--data-dir', data, '--jwt-priv-key-path', join(keys, 'id_ecdsa'), '--jwt-pub-key-path', join(keys, 'id_ecdsa.pub')],
  { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let startupError: Error | undefined;
  server.once('error', error => { startupError = error; });
  for (const stream of [server.stdout!, server.stderr!]) stream.on('data', chunk => { serverLog = (serverLog + String(chunk)).slice(-5000); });
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    if (startupError || server.exitCode !== null || server.signalCode !== null) throw new Error(`Server startup failed: ${startupError ?? serverLog}`);
    if (stopped) throw new Error('Drill interrupted');
    try { if ((await fetch(`${origin}/v1/ping`, { signal: AbortSignal.timeout(500) })).ok) return origin; } catch { /* Starting. */ }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Server startup timed out: ${serverLog}`);
}

async function main(): Promise<void> {
  assert.match(await command(cli, ['--version']), /spacetimedb tool version 2\.10\.2;/);
  console.log('[backup drill] Build committed module in isolation');
  const archive = join(dir, 'module.tar');
  await command('git', ['archive', 'HEAD', 'spacetimedb', '--output', archive]);
  await command('tar', ['-xf', archive, '-C', dir]);
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const keys = join(dir, 'keys');
  const data = join(dir, 'data');
  const artifacts = join(dir, 'artifacts');
  const tokens = join(dir, 'tokens');
  for (const folder of [keys, artifacts, tokens]) mkdirSync(folder, { mode: 0o700 });
  await command('openssl', ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-out', join(keys, 'id_ecdsa')]);
  await command('openssl', ['ec', '-in', join(keys, 'id_ecdsa'), '-pubout', '-out', join(keys, 'id_ecdsa.pub')]);
  let origin = await start(data, keys);
  const response = await fetch(`${origin}/v1/identity`, { method: 'POST' });
  assert(response.ok);
  const identity = await response.json() as { token: string; identity: string };
  assert(identity.token && identity.identity);
  writeFileSync(join(tokens, 'operator.token'), identity.token, { mode: 0o600 });
  await command(cli, ['--config-path', config, 'login', '--token', identity.token]);
  await command(cli, ['--config-path', config, 'publish', '--module-path', join(dir, 'spacetimedb'),
    '--server', origin, '--no-config', '--yes', database]);
  const call = (name: string, ...args: string[]) => command(cli, ['--config-path', config, 'call', '--server', origin, '--no-config', database, name, ...args]);
  await call('grant_agent', identity.identity, 'operator');
  await call('create_run', 'recovery-test', 'Synthetic recovery test; no broker activity');
  await call('grant_run_access', identity.identity, 'recovery-test');
  await call('create_task', 'recovery-task', 'recovery-test', 'QTEST', 'thesis', 'Recovery sentinel', '', '');
  const artifact = join(artifacts, 'filing.txt');
  writeFileSync(artifact, 'Synthetic source artifact for recovery acceptance.\n', { mode: 0o600 });
  const checksum = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  await call('grant_agent', identity.identity, 'ingestor');
  await call('add_source', 'recovery-source', 'recovery-test', 'QTEST', 'fixture', 'fixture://recovery', '[0]', checksum, `file://${artifact}`);
  await call('add_fact', 'recovery-fact', 'recovery-source', 'QTEST', 'synthetic', '1', 'count', 'test', 'fixture');
  await call('grant_agent', identity.identity, 'operator');
  await call('post_message', 'recovery-message', 'recovery-test', 'recovery-task', 'QTEST', '', 'observation', 'Durable recovery sentinel', 'recovery-source');
  await call('set_run_status', 'recovery-test', 'paused');
  const tables = ['owner_config', 'agent', 'run', 'task', 'message', 'source', 'fact'];
  const snapshot = async () => {
    const results: Record<string, string> = {};
    for (const table of tables) {
      const output = await command(cli, ['--config-path', config, 'sql', '--server', origin,
        '--no-config', '--format', 'json', database, `SELECT * FROM ${table}`]);
      const parsed = JSON.parse(output.slice(output.indexOf('[{'))) as { schema: unknown; rows: unknown[] }[];
      results[table] = JSON.stringify(parsed.map(({ schema, rows }) => ({ schema, rows })));
    }
    return results;
  };
  const before = await snapshot();
  assert.match(before.message, /Durable recovery sentinel/);
  const bundle = join(dir, 'bundle');
  const saveArgs = [join(root, 'scripts/backup.sh'), bundle, '--data-dir', data, '--artifacts-dir', artifacts,
    '--tokens-dir', tokens, '--jwt-private-key', join(keys, 'id_ecdsa'), '--jwt-public-key', join(keys, 'id_ecdsa.pub')];
  assert.match(await command('sh', saveArgs, false), /SpacetimeDB is running/);
  assert(!existsSync(bundle));
  await stopServer();
  console.log('[backup drill] Active server refused; take offline bundle');
  await command('sh', saveArgs);
  // Hide originals; restore artifact to its original absolute path so stored refs still resolve.
  for (const folder of [data, artifacts, tokens, keys]) renameSync(folder, `${folder}.original`);
  const restoredData = join(dir, 'restored-data');
  const restoredKeys = join(dir, 'restored-keys');
  const restoreArgs = [join(root, 'scripts/restore.sh'), bundle, '--data-dir', restoredData, '--artifacts-dir', artifacts,
    '--tokens-dir', tokens, '--identity-dir', restoredKeys];
  const copiedArtifact = join(bundle, 'artifacts', 'filing.txt');
  const bytes = readFileSync(copiedArtifact);
  writeFileSync(copiedArtifact, 'tampered');
  assert.match(await command('sh', restoreArgs, false), /checksum verification failed/);
  assert(!existsSync(restoredData));
  writeFileSync(copiedArtifact, bytes);
  await command('sh', restoreArgs);
  assert.match(await command('sh', restoreArgs, false), /Destination already exists/);
  assert.equal(readFileSync(join(tokens, 'operator.token'), 'utf8'), identity.token);
  assert.equal(createHash('sha256').update(readFileSync(artifact)).digest('hex'), checksum);
  origin = await start(restoredData, restoredKeys);
  // Same owner token must still authenticate with restored JWT keys and authoritative grants.
  assert.deepEqual(await snapshot(), before);
  await call('set_run_status', 'recovery-test', 'active');
  await call('set_run_status', 'recovery-test', 'paused');
  console.log('[backup drill] PASS: seven table snapshots, owner identity, worker token, source checksum/reference, and pause writes survived restore; corruption and overwrite refused.');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  stopped = true;
  for (const child of children) child.kill('SIGTERM');
  killServer('SIGTERM');
});
try { await main(); }
catch (error) { console.error(`[backup drill] ${String(error)}`); process.exitCode = 1; }
finally {
  for (const child of children) child.kill('SIGKILL');
  await stopServer();
  rmSync(dir, { recursive: true, force: true });
}
