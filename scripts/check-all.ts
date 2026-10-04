#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Every database mutation runs against this invocation's temporary server and CLI config.
// Provider credentials are removed so acceptance checks cannot accidentally use them.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env: NodeJS.ProcessEnv = { ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}:${join(homedir(), '.local', 'bin')}` };
for (const name of Object.keys(env)) if (/^(ALPACA_|ANTHROPIC_|OPENAI_|AGENT_|RUN_ID$|MAX_ORDER_NOTIONAL$)/.test(name)) delete env[name];
const cli = process.env.SPACETIME_CLI ?? 'spacetime';
const children = new Set<ChildProcess>();
let stopping = false;
let directory: string | undefined;
let server: ChildProcess | undefined;
let serverOutput = '';

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch { /* Already stopped. */ }
}

async function stop(child: ChildProcess): Promise<void> {
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve() : new Promise<void>(done => child.once('close', () => done()));
  terminate(child, 'SIGTERM');
  // The acceptance subprocess can have worker grandchildren even if it already exited.
  const force = setTimeout(() => terminate(child, 'SIGKILL'), 3000);
  await exited;
  clearTimeout(force);
  terminate(child, 'SIGKILL');
}

async function run(command: string, args: string[], label: string, timeoutMs = 180_000,
  quiet = false): Promise<string> {
  if (stopping) throw new Error('Checks interrupted');
  console.log(`\n[check:all] ${label}`);
  return await new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; terminate(child, 'SIGKILL'); }, timeoutMs);
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (bytes: Buffer) => {
      output = (output + bytes.toString()).slice(-100_000);
      if (!quiet) process.stdout.write(bytes);
    });
    child.on('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
    child.on('close', code => {
      clearTimeout(timer); children.delete(child);
      terminate(child, 'SIGKILL');
      if (code === 0 && !timedOut && !stopping) done(output);
      else reject(new Error(`${label} ${timedOut ? 'timed out' : `failed (exit ${code})`}${quiet ? '' : '; see output above'}`));
    });
  });
}

async function unusedPort(): Promise<number> {
  return await new Promise((done, reject) => {
    const listener = createServer();
    listener.on('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string') { listener.close(); reject(new Error('No temporary TCP port')); return; }
      listener.close(error => error ? reject(error) : done(address.port));
    });
  });
}

function files(path: string, prefix = ''): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + entry.name;
    return entry.isDirectory() ? files(join(path, entry.name), `${relative}/`) : [relative];
  }).sort();
}

function checkBindings(generated: string): void {
  const committed = join(root, 'src/module_bindings');
  const paths = new Set([...files(committed), ...files(generated)]);
  const changed = [...paths].filter(path => !existsSync(join(committed, path)) || !existsSync(join(generated, path)) ||
    !readFileSync(join(committed, path)).equals(readFileSync(join(generated, path))));
  if (changed.length) throw new Error(`Generated bindings are stale: ${changed.join(', ')}. Run npm run db:generate and include the updated bindings.`);
  console.log('[check:all] Generated bindings match the module.');
}

async function main(): Promise<void> {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('check:all requires Node.js 24 or newer (native TypeScript support).');
  const version = spawnSync(cli, ['--version'], { cwd: root, env, encoding: 'utf8' });
  if (version.error) throw new Error(`SpacetimeDB CLI is missing. Install 2.10.2 or set SPACETIME_CLI to its executable.`);
  if (version.status !== 0 || !/spacetimedb tool version 2\.10\.2;/.test(version.stdout)) {
    throw new Error('check:all requires SpacetimeDB CLI 2.10.2. Run spacetime version install 2.10.2 --use --yes.');
  }
  directory = mkdtempSync(join(tmpdir(), 'quant-check-all-'));
  const config = join(directory, 'cli.toml');
  const cliArgs = ['--config-path', config];
  const bindings = join(directory, 'bindings');
  await run(cli, [...cliArgs, 'build', '--module-path', 'spacetimedb'], 'Build SpacetimeDB module');
  await run(cli, [...cliArgs, 'generate', '--lang', 'typescript', '--module-path', 'spacetimedb',
    '--out-dir', bindings, '--no-config', '--yes'], 'Verify generated bindings', 180_000, true);
  checkBindings(bindings);
  await run(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '--target', 'ES2022', '--module', 'ESNext',
    '--moduleResolution', 'bundler', '--strict', '--skipLibCheck', '--types', 'node', '--allowImportingTsExtensions',
    'scripts/check-all.ts', 'scripts/check-app-readiness.ts'], 'Typecheck check runners');
  await run('npm', ['run', 'typecheck'], 'Typecheck workers and module');
  await run(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', 'dashboard/tsconfig.json'], 'Typecheck dashboard');
  await run('npm', ['run', 'build'], 'Build workers and adapters');
  const testEntries = files(join(root, 'src')).filter(path => path.endsWith('.test.ts')).map(path => join('src', path));
  if (!testEntries.length) throw new Error('No TypeScript unit-test entries were found.');
  const testBundles = join(directory, 'unit-tests');
  const bundledTests: string[] = [];
  for (const entry of testEntries) {
    const output = join(testBundles, entry.slice('src/'.length).replace(/\.test\.ts$/, '.test.js'));
    mkdirSync(dirname(output), { recursive: true });
    await build({ entryPoints: [join(root, entry)], outfile: output, bundle: true, platform: 'node', format: 'esm',
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(join(root, entry)).href) } });
    bundledTests.push(output);
  }
  if (!bundledTests.length) throw new Error('Unit-test bundling produced no runnable entries.');
  await run(process.execPath, ['--test', ...bundledTests], 'Run unit tests');
  await run(join(root, 'node_modules/.bin/esbuild'), ['dashboard/app.ts', '--bundle', '--platform=browser',
    '--format=esm', `--outfile=${join(directory, 'dashboard.js')}`], 'Build dashboard');

  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  console.log(`\n[check:all] Start isolated server at ${origin}`);
  server = spawn(cli, [...cliArgs, 'start', '--listen-addr', `127.0.0.1:${port}`, '--data-dir',
    join(directory, 'data'), '--non-interactive'], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let startupError: Error | undefined;
  server.on('error', error => { startupError = error; });
  for (const stream of [server.stdout!, server.stderr!]) stream.on('data', bytes => {
    serverOutput = (serverOutput + String(bytes)).slice(-8000);
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (startupError || server.exitCode !== null || server.signalCode !== null) throw new Error(`Temporary server failed: ${startupError ?? serverOutput}`);
    if (stopping) throw new Error('Checks interrupted');
    try { if ((await fetch(`${origin}/v1/ping`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* Starting. */ }
    if (Date.now() > deadline) throw new Error(`Temporary server did not start: ${serverOutput}`);
    await new Promise(done => setTimeout(done, 100));
  }
  // Host-issued identity needs no external login and is kept only in the temporary CLI config.
  const response = await fetch(`${origin}/v1/identity`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Could not create temporary publisher identity');
  const identity = await response.json() as { token?: string; identity?: string };
  if (!identity.token || !identity.identity) throw new Error('Temporary identity response is incomplete');
  await run(cli, [...cliArgs, 'login', '--token', identity.token], 'Configure temporary publisher', 10_000, true);
  const database = 'quant-swarm-check';
  await run(cli, [...cliArgs, 'publish', '--module-path', 'spacetimedb', '--server', origin,
    '--no-config', '--yes', database], 'Publish isolated module');
  await run(cli, [...cliArgs, 'call', '--server', origin, database, 'grant_agent',
    identity.identity, 'operator'], 'Grant temporary publisher operator role');
  Object.assign(env, { SPACETIME_CLI: cli, SPACETIME_CONFIG_PATH: config, SPACETIME_SERVER: origin,
    SPACETIMEDB_HOST: `ws://127.0.0.1:${port}`, SPACETIMEDB_DB_NAME: database });
  await run('npm', ['run', 'check:research-fixture'], 'Structured research reducer fixtures');
  await run('npm', ['run', 'check:phase-one'], 'Worker recovery and authoritative risk acceptance', 240_000);
  await run('npm', ['run', 'check:executor'], 'Mock broker executor crash, fill and reconciliation acceptance', 120_000);
  console.log('\n[check:all] All checks passed.');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  stopping = true;
  for (const child of children) terminate(child, 'SIGTERM');
  if (server) terminate(server, 'SIGTERM');
});

if (process.argv.includes('--app') || process.argv.includes('--help') || process.argv.includes('--readiness-help')) {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    console.error('[check:all] Application readiness modes require Node.js 24 or newer.');
    process.exitCode = 1;
  } else {
    const result = spawnSync(process.execPath, [join(root, 'scripts/check-app-readiness.ts'), ...process.argv.slice(2)], {
      cwd: root, env: process.env, stdio: 'inherit', windowsHide: true,
    });
    if (result.error) { console.error(`[check:all] Could not start application readiness runner: ${String(result.error)}`); process.exitCode = 1; }
    else process.exitCode = result.status ?? 1;
  }
} else {
  try { await main(); }
  catch (error) { console.error(`[check:all] ${String(error)}`); process.exitCode = 1; }
  finally {
    await Promise.all([...children].map(stop));
    if (server) await stop(server);
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
