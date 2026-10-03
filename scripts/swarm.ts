#!/usr/bin/env node
// Local swarm supervisor. Usage: node scripts/swarm.ts <plan|register|grants|up|status> [--config config/swarm.json]
// Agent counts per role, model brains, and the run come from the config (copy config/swarm.example.json to the
// ignored config/swarm.json). Secrets are read from your shell environment and never written anywhere.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSwarmConfig, planGrants, planProcesses, runPolicy, type Command, type ProcessSpec, type SwarmConfig } from '../src/swarm-plan.ts';

// fileURLToPath decodes the URL, so paths with spaces ("Quant Swarm") resolve correctly.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = process.env.SPACETIME_CLI ?? 'spacetime';
const ENV = { ...process.env, PATH: `${process.env.PATH ?? ''}:${path.join(os.homedir(), '.local', 'bin')}` };
const LOG_DIR = path.join(ROOT, 'logs');
const STATE_FILE = path.join(LOG_DIR, 'swarm-state.json');

const HELP = `Swarm supervisor
  plan                 Show the processes the config starts and the environment variables they need
  register             Create a SpacetimeDB identity for every process that has none yet
  grants [--apply]     Print (or run, as the owner CLI identity) the role, run, account, and policy setup
  up [--start-db] [--no-build]   Seed research, start every process, restart crashes, stop all on Ctrl+C
  status               Process state, heartbeats, and run progress
Options: --config <file> (default config/swarm.json)`;

const args = process.argv.slice(2);
const command = args.find(a => !a.startsWith('--'));
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function loadConfig(): SwarmConfig {
  const file = path.resolve(ROOT, option('config') ?? 'config/swarm.json');
  if (!fs.existsSync(file)) fail(`No config at ${path.relative(ROOT, file)}. Copy config/swarm.example.json to config/swarm.json and edit it.`);
  try { return parseSwarmConfig(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`Invalid config ${path.relative(ROOT, file)}: ${(error as Error).message}`); }
}

const tokenPath = (name: string) => path.join(os.homedir(), '.local', 'share', 'quant-swarm', 'tokens', `${name}.token`);

// SpacetimeDB tokens are JWTs whose hex_identity claim is the identity; no connection is needed to read it.
function identityOf(name: string): string | undefined {
  try {
    const payload = fs.readFileSync(tokenPath(name), 'utf8').trim().split('.')[1];
    return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { hex_identity?: string }).hex_identity;
  } catch { return undefined; }
}

function spacetime(argv: string[]): string {
  try {
    return execFileSync(CLI, argv, { env: ENV, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? error);
    throw new Error(/Response text: (.*)/.exec(stderr)?.[1] ?? stderr.split('\n').filter(l => l.trim() && !l.includes('UNSTABLE')).slice(0, 2).join(' '));
  }
}

function ownerIdentity(): string {
  const match = /logged in as ([0-9a-f]{64})/.exec(spacetime(['login', 'show']));
  if (!match) fail('The SpacetimeDB CLI has no identity. Run `spacetime login` first.');
  return match[1];
}

type Row = Record<string, unknown>;
// Reads tables as the owner (who can read private tables) through a one-shot subscription that returns JSON.
function query(config: SwarmConfig, ...queries: string[]): Record<string, Row[]> {
  const out = spacetime(['subscribe', '--server', config.server, config.database, ...queries, '--print-initial-update', '-n', '0', '--yes']);
  const line = out.split('\n').find(l => l.startsWith('{'));
  const update = line ? JSON.parse(line) as Record<string, { inserts: Row[] }> : {};
  return Object.fromEntries(Object.entries(update).map(([table, value]) => [table, value.inserts]));
}

function call(config: SwarmConfig, reducer: string, values: (string | number)[]): void {
  spacetime(['call', '--server', config.server, config.database, reducer, ...values.map(v => JSON.stringify(v))]);
}

const sql = (value: string) => `'${value.replace(/'/g, "''")}'`;
const identityHex = (row: Row) => String((row.identity as { __identity__?: string })?.__identity__ ?? '').replace(/^0x/, '');
const micros = (value: unknown) => Number((value as { __timestamp_micros_since_unix_epoch__: number }).__timestamp_micros_since_unix_epoch__);

async function dbReachable(config: SwarmConfig): Promise<boolean> {
  try {
    const url = new URL('/v1/ping', config.host.replace(/^ws/, 'http'));
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch { return false; }
}

function build(): void {
  console.log('Building…');
  execFileSync('npm', ['run', '--silent', 'build'], { cwd: ROOT, env: ENV, stdio: 'inherit' });
}

function processEnv(p: ProcessSpec, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...ENV, ...p.env, AGENT_NAME: p.name, [p.tokenFileEnv]: tokenPath(p.name), ...extra };
}

function missingSecrets(processes: ProcessSpec[]): string[] {
  return [...new Set(processes.flatMap(p => p.secrets))].filter(name => !process.env[name]?.trim());
}

function plan(): void {
  const config = loadConfig();
  const processes = planProcesses(config);
  console.log(`Run ${config.runId} on ${config.server}/${config.database}`);
  for (const p of processes) {
    const mode = p.periodicSeconds ? `every ${p.periodicSeconds}s` : p.oneShot ? 'once per research symbol' : 'continuous';
    const brain = p.env.AGENT_BRAIN ? `, brain ${p.env.AGENT_BRAIN}` : '';
    console.log(`  ${p.name.padEnd(28)} ${p.role.padEnd(12)} ${mode}${brain}${identityOf(p.name) ? '' : '  (no identity yet)'}`);
  }
  const needed = [...new Set(processes.flatMap(p => p.secrets))];
  console.log(`Environment needed: ${needed.length ? needed.join(', ') : 'none'}${missingSecrets(processes).length ? `; missing now: ${missingSecrets(processes).join(', ')}` : ''}`);
  if (processes.some(p => p.env.AGENT_BRAIN === 'claude') && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log('Note: Claude brains need ANTHROPIC_API_KEY (or an `ant auth login` profile).');
  }
}

// Identities come from each process's first connection. Workers have no --register flag, so they are started
// just long enough to print their identity.
async function register(): Promise<void> {
  const config = loadConfig();
  if (!await dbReachable(config)) fail('The local SpacetimeDB server is not reachable. Start it with `npm run db:start`.');
  if (!flag('no-build')) build();
  for (const p of planProcesses(config)) {
    if (identityOf(p.name)) { console.log(`${p.name}: ${identityOf(p.name)}`); continue; }
    await new Promise<void>((resolve, reject) => {
      const supportsRegister = p.script !== 'worker.js';
      const child = spawn('node', [path.join(ROOT, 'dist', p.script), ...(supportsRegister ? ['--register'] : [])],
        { cwd: ROOT, env: processEnv(p), stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${p.name} did not register within 20s`)); }, 20_000);
      child.stdout.on('data', () => { if (identityOf(p.name)) child.kill('SIGINT'); });
      child.on('exit', () => {
        clearTimeout(timer);
        if (identityOf(p.name)) { console.log(`${p.name}: ${identityOf(p.name)} (new)`); resolve(); }
        else reject(new Error(`${p.name} exited without saving a token`));
      });
    });
  }
}

async function accountIdFor(config: SwarmConfig, needed: boolean): Promise<string> {
  if (config.accountId || !needed) return config.accountId;
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_API_SECRET) return '';
  const { credentialsFromEnv, getAccount, object, textField } = await import('../src/alpaca-client.ts');
  return textField(object(await getAccount(credentialsFromEnv()), 'account'), 'id', 'account ID');
}

function shellQuote(value: string | number): string {
  const text = String(value);
  return /^[A-Za-z0-9._:/=-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

async function grants(): Promise<void> {
  const config = loadConfig();
  const processes = planProcesses(config);
  const identities = new Map(processes.map(p => [p.name, identityOf(p.name)]).filter((e): e is [string, string] => !!e[1]));
  const accountId = await accountIdFor(config, processes.some(p => p.accountAccess));
  const runExists = (query(config, `SELECT * FROM run WHERE id = ${sql(config.runId)}`).run ?? []).length > 0;
  const policy = config.agents.risk.count
    ? runPolicy(fs.readFileSync(path.resolve(ROOT, config.riskPolicyFile), 'utf8'), config.runId) : undefined;
  let commands: Command[];
  try { commands = planGrants(config, processes, identities, ownerIdentity(), accountId, runExists, policy); }
  catch (error) { fail((error as Error).message); }
  if (!flag('apply')) {
    for (const c of commands) console.log(`# ${c.note}\nspacetime call --server ${config.server} ${config.database} ${c.reducer} ${c.args.map(shellQuote).join(' ')}`);
    console.log('\nRun with --apply to execute these as the owner CLI identity.');
    return;
  }
  for (const c of commands) {
    try { call(config, c.reducer, c.args); console.log(`ok   ${c.reducer.padEnd(22)} ${c.note}`); }
    catch (error) { fail(`fail ${c.reducer.padEnd(22)} ${c.note}: ${(error as Error).message}`); }
  }
}

// ── up ──────────────────────────────────────────────────────────────────────

interface Managed { spec: ProcessSpec; child?: ChildProcess; restarts: number; startedAt: number; nextRunAt?: number }
const managed = new Map<string, Managed>();
let stopping = false;

function logLine(name: string, line: string, stream: fs.WriteStream): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  stream.write(`${stamped}\n`);
  console.log(`[${name}] ${line}`);
}

function writeState(): void {
  const state = { supervisorPid: process.pid, updatedAt: new Date().toISOString(), processes: Object.fromEntries(
    [...managed.values()].map(m => [m.spec.name, { role: m.spec.role, pid: m.child?.pid ?? null, restarts: m.restarts,
      startedAt: new Date(m.startedAt).toISOString(), periodicSeconds: m.spec.periodicSeconds ?? null }])) };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// The local database server is supervised like the agents when `up --start-db` is used.
const DB_SPEC: ProcessSpec = { name: 'spacetimedb', role: 'operator' as never, script: '', args: [], env: {}, secrets: [],
  accountAccess: false, tokenFileEnv: 'AGENT_TOKEN_FILE' };

// Starts a process with its output prefixed on the console and appended to logs/<name>.log.
function launch(spec: ProcessSpec, extra: Record<string, string> = {}): ChildProcess {
  const stream = fs.createWriteStream(path.join(LOG_DIR, `${spec.name}.log`), { flags: 'a' });
  const [cmd, argv] = spec.script ? ['node', [path.join(ROOT, 'dist', spec.script), ...spec.args]] : ['npm', ['run', '--silent', 'db:start']];
  const child = spawn(cmd, argv as string[], { cwd: ROOT, env: spec.script ? processEnv(spec, extra) : ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const source of [child.stdout!, child.stderr!]) {
    let buffer = '';
    source.setEncoding('utf8');
    source.on('data', (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) { logLine(spec.name, buffer.slice(0, i), stream); buffer = buffer.slice(i + 1); }
    });
  }
  child.on('exit', () => stream.end());
  return child;
}

function runOnce(spec: ProcessSpec, extra: Record<string, string> = {}): Promise<number> {
  return new Promise(resolve => launch(spec, extra).on('exit', code => resolve(code ?? 1)));
}

// Continuous processes restart with exponential backoff; the delay resets after a minute of healthy running.
function startContinuous(spec: ProcessSpec): void {
  const entry: Managed = managed.get(spec.name) ?? { spec, restarts: 0, startedAt: Date.now() };
  managed.set(spec.name, entry);
  const child = launch(spec);
  entry.child = child;
  entry.startedAt = Date.now();
  writeState();
  child.on('exit', (code, signal) => {
    entry.child = undefined;
    if (stopping) return writeState();
    const healthy = Date.now() - entry.startedAt > 60_000;
    entry.restarts = healthy ? 0 : entry.restarts + 1;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(entry.restarts, 6));
    console.log(`[swarm] ${spec.name} exited (${signal ?? `code ${code}`}); restarting in ${delay / 1000}s`);
    writeState();
    setTimeout(() => { if (!stopping) startContinuous(spec); }, delay);
  });
}

function schedulePeriodic(spec: ProcessSpec): void {
  const entry: Managed = { spec, restarts: 0, startedAt: Date.now() };
  managed.set(spec.name, entry);
  const tick = async () => {
    if (stopping) return;
    const code = await runOnce(spec);
    if (code !== 0) console.log(`[swarm] ${spec.name} run failed (code ${code}); next run in ${spec.periodicSeconds}s`);
    entry.nextRunAt = Date.now() + spec.periodicSeconds! * 1000;
    if (!stopping) setTimeout(tick, spec.periodicSeconds! * 1000);
  };
  setTimeout(tick, spec.periodicSeconds! * 1000);
}

// One analyst thesis task per research symbol, after loading its evidence. Existing tasks are left alone.
async function seedResearch(config: SwarmConfig, ingestor: ProcessSpec | undefined): Promise<void> {
  if (!config.research) return;
  const tasks = query(config, `SELECT * FROM task WHERE run_id = ${sql(config.runId)}`).task ?? [];
  for (const symbol of config.research.symbols) {
    const id = `${config.runId}.thesis.${symbol}`.slice(0, 128);
    if (tasks.some(t => t.id === id)) { console.log(`[swarm] ${id} already exists`); continue; }
    if (ingestor) {
      const code = await runOnce(ingestor, { SYMBOL: symbol });
      if (code !== 0) { console.log(`[swarm] Evidence ingest for ${symbol} failed; not queuing a thesis task`); continue; }
    }
    call(config, 'create_task', [id, config.runId, symbol, 'thesis', config.research.objective, 'analyst', '']);
    console.log(`[swarm] Queued ${id}`);
  }
}

async function up(): Promise<void> {
  const config = loadConfig();
  const processes = planProcesses(config);
  const missing = missingSecrets(processes);
  if (missing.length) fail(`Missing environment variables: ${missing.join(', ')}. Export them in this shell (values are never stored).`);
  fs.mkdirSync(LOG_DIR, { recursive: true });

  if (!await dbReachable(config)) {
    if (!flag('start-db')) fail('The local SpacetimeDB server is not reachable. Start it with `npm run db:start`, or pass --start-db.');
    startContinuous(DB_SPEC);
    for (let i = 0; i < 30 && !await dbReachable(config); i++) await new Promise(r => setTimeout(r, 1_000));
    if (!await dbReachable(config)) fail('SpacetimeDB did not become reachable within 30s');
  }
  if (!flag('no-build')) build();

  // Refuse to start with missing identities or grants rather than letting processes idle unauthorized.
  const agents = new Map((query(config, 'SELECT * FROM agent').agent ?? []).map(a => [identityHex(a), String(a.role)]));
  const problems = processes.flatMap(p => {
    const identity = identityOf(p.name);
    if (!identity) return [`${p.name} has no identity (run register)`];
    return agents.get(identity) === p.role ? [] : [`${p.name} is not granted ${p.role} (run grants --apply)`];
  });
  if (problems.length) fail(`Not ready:\n  ${problems.join('\n  ')}`);

  const marketData = processes.find(p => p.periodicSeconds);
  if (marketData) await runOnce(marketData); // fresh quotes before the first research cycle
  await seedResearch(config, processes.find(p => p.oneShot));

  for (const p of processes) {
    if (p.oneShot) continue;
    if (p.periodicSeconds) schedulePeriodic(p); else startContinuous(p);
  }
  writeState();
  console.log(`[swarm] ${processes.filter(p => !p.oneShot).length} processes running for run ${config.runId}. Logs in logs/. Ctrl+C stops all.`);

  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log('[swarm] Stopping…');
    for (const m of managed.values()) m.child?.kill('SIGINT');
    const deadline = setTimeout(() => {
      for (const m of managed.values()) m.child?.kill('SIGKILL');
      process.exit(0);
    }, 10_000);
    const poll = setInterval(() => {
      if ([...managed.values()].every(m => !m.child)) { clearInterval(poll); clearTimeout(deadline); fs.rmSync(STATE_FILE, { force: true }); process.exit(0); }
    }, 200);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// ── status ──────────────────────────────────────────────────────────────────

function alive(pid: unknown): boolean {
  if (typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function ago(us: number): string {
  const s = Math.round((Date.now() - us / 1000) / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

function status(): void {
  const config = loadConfig();
  const processes = planProcesses(config);
  const state = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { supervisorPid: number; processes: Record<string, { pid: number | null; restarts: number }> }
    : undefined;
  const supervising = state && alive(state.supervisorPid);
  console.log(`Supervisor: ${supervising ? `running (pid ${state!.supervisorPid})` : 'not running'}`);
  const tables = query(config, 'SELECT * FROM agent', `SELECT * FROM task WHERE run_id = ${sql(config.runId)}`,
    `SELECT * FROM trade_proposal WHERE run_id = ${sql(config.runId)}`, 'SELECT * FROM paper_order');
  const agents = new Map((tables.agent ?? []).map(a => [identityHex(a), a]));
  for (const p of processes) {
    const entry = supervising ? state!.processes[p.name] : undefined;
    const proc = p.oneShot ? 'one-shot' : p.periodicSeconds ? 'periodic' : entry && alive(entry.pid) ? `up (pid ${entry.pid}${entry.restarts ? `, ${entry.restarts} restarts` : ''})` : 'down';
    const agent = agents.get(identityOf(p.name) ?? '');
    const heartbeat = agent ? `${agent.role}, ${agent.status}, seen ${ago(micros(agent.last_seen))}` : 'not granted';
    console.log(`  ${p.name.padEnd(28)} ${proc.padEnd(26)} ${heartbeat}`);
  }
  const count = (rows: Row[] | undefined, key: string) => Object.entries((rows ?? []).reduce<Record<string, number>>((acc, r) => {
    acc[String(r[key])] = (acc[String(r[key])] ?? 0) + 1; return acc; }, {})).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  const proposalIds = new Set((tables.trade_proposal ?? []).map(p => p.id));
  console.log(`Run ${config.runId}: tasks ${count(tables.task, 'status')}; proposals ${count(tables.trade_proposal, 'status')}; ` +
    `orders ${count((tables.paper_order ?? []).filter(o => proposalIds.has(o.proposal_id)), 'status')}`);
}

const commands: Record<string, () => void | Promise<void>> = { plan, register, grants, up, status };
const run = command ? commands[command] : undefined;
if (!run) console.log(HELP);
else Promise.resolve(run()).catch(error => fail(String((error as Error).message ?? error)));
