#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { readinessStatus, releaseStatus, type ApplicationId, type ReadinessStatus } from '../src/application-readiness.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = process.env.SPACETIME_CLI ?? 'spacetime';
const apps: ApplicationId[] = ['factorio', 'minecraft', 'paper'];
const requiredLiveGates: Record<ApplicationId, string[]> = {
  factorio: ['factorio-f2-ten-workers', 'factorio-f2-dashboard', 'factorio-f3-fault-suite',
    'factorio-live-demo-guide', 'factorio-acceptance-review'],
  minecraft: ['minecraft-pilot-choices', 'minecraft-server', 'minecraft-commands', 'minecraft-worker',
    'minecraft-shared-state', 'minecraft-ten-agents', 'minecraft-recovery', 'minecraft-sharing-eval',
    'game-operator-dashboard', 'minecraft-live-demo-guide'],
  paper: ['trading-pilot-choices', 'trading-ops-deployment', 'trading-connectivity-acceptance',
    'trading-risk-live-acceptance', 'trading-model-acceptance', 'trading-paper-order-acceptance',
    'trading-order-stream', 'trading-operator-cancel', 'trading-dashboard-acceptance',
    'trading-position-reviews', 'trading-corporate-actions', 'trading-strategy-contract',
    'trading-evaluation-alerts', 'trading-live-demo-guide'],
};

interface Options { selected: ApplicationId[]; runFixtures: boolean; evidence?: string }
interface HashRecord { path: string; sha256: string; bytes: number }
interface Gate { status: ReadinessStatus; requirement: string; evidence: string[]; blockers: string[] }
interface AppReport {
  application: ApplicationId;
  releaseStatus: ReadinessStatus;
  gates: Record<string, Gate>;
  preflight: { checks: { name: string; status: 'available' | 'missing' | 'not-checked'; detail: string }[] };
  hashes: HashRecord[];
  suiteRuns: { command: string; status: 'passed' | 'failed' | 'not-run'; outputSha256?: string }[];
  liveEvidence?: { sha256: string; artifactHashes: string[] };
}

function parseArgs(argv: string[]): Options | 'help' {
  let app: string | undefined;
  let runFixtures = false;
  let evidence: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--app') app = argv[++i];
    else if (arg === '--dry-run') runFixtures = false;
    else if (arg === '--run-fixtures') runFixtures = true;
    else if (arg === '--evidence') evidence = argv[++i];
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!app) throw new Error('Specify --app factorio|minecraft|paper|all. Dry-run is the default.');
  if (app === 'alpaca' || app === 'alpaca-paper' || app === 'trading') app = 'paper';
  const selected = app === 'all' ? [...apps] : apps.includes(app as ApplicationId) ? [app as ApplicationId] : [];
  if (!selected.length) throw new Error(`Unknown application: ${app}`);
  if (evidence && selected.length !== 1) throw new Error('--evidence can be used with one application at a time.');
  return { selected, runFixtures, evidence };
}

function hash(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }

function listFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const info = statSync(path);
  if (info.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.')) return [];
    const child = join(path, entry.name);
    return entry.isDirectory() ? listFiles(child) : entry.isFile() ? [child] : [];
  }).sort();
}

function hashPaths(paths: string[]): HashRecord[] {
  const files = [...new Set(paths.flatMap(path => listFiles(join(root, path))))].sort();
  return files.map(path => {
    const bytes = readFileSync(path);
    return { path: relative(root, path).split('\n').join('/'), sha256: hash(bytes), bytes: bytes.length };
  });
}

function version(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (result.status !== 0) return undefined;
  return `${result.stdout}${result.stderr}`.trim().split('\n').filter(line => !/^(spacetime Path:|Commit:)/.test(line.trim()))
    .slice(0, 3).join(' ').slice(0, 300);
}

function factorioBinary(): string {
  if (process.env.FACTORIO_BIN) return process.env.FACTORIO_BIN;
  let release = '2.0.77';
  try { release = JSON.parse(readFileSync(join(root, 'config/factorio-pilot.json'), 'utf8')).version; } catch { /* Missing config is reported separately. */ }
  return join(homedir(), '.local/share/agent-swarm/factorio', release, 'factorio/bin/x64/factorio');
}

function preflight(app: ApplicationId): AppReport['preflight'] {
  const check = (name: string, value: string | undefined, detail: string) => ({
    name, status: value ? 'available' as const : 'missing' as const, detail,
  });
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const checks = [check('Node.js 24+', nodeMajor >= 24 ? process.versions.node : undefined, 'Native TypeScript runner requirement')];
  if (app === 'factorio') {
    const binary = factorioBinary();
    const python = version('python3', ['--version']);
    checks.push(check('Factorio 2.0.77 binary', existsSync(binary) ? 'present' : undefined, 'Configured executable presence only; dry-run never launches it'));
    checks.push(check('Python 3.9+', python && Number(python.match(/\d+\.(\d+)/)?.[1] ?? 0) >= 9 ? python : undefined,
      'Used only for isolated Factorio fixture checks'));
  } else if (app === 'minecraft') {
    const java = version('java', ['-version']);
    const javaMajor = Number(java?.match(/version "(?:1\.)?(\d+)/)?.[1] ?? 0);
    checks.push(check('Java 21+', javaMajor >= 21 ? java : undefined, 'Version probe only; server is never started by dry-run'));
    const jar = process.env.MINECRAFT_SERVER_JAR;
    checks.push(check('Minecraft server jar', jar && existsSync(jar) ? 'present' : undefined,
      'Path is checked only; EULA is never read or accepted'));
  } else {
    const cliVersion = version(cli, ['--version']);
    checks.push(check('SpacetimeDB CLI 2.10.2', cliVersion && /spacetimedb tool version 2\.10\.2;/.test(cliVersion) ? cliVersion : undefined,
      'Version probe only; dry-run does not connect to a database'));
  }
  return { checks };
}

function sourcePaths(app: ApplicationId): string[] {
  const common = ['package-lock.json', 'scripts/check-all.ts', 'scripts/check-app-readiness.ts',
    'src/application-readiness.ts', 'src/application-readiness.test.ts'];
  if (app === 'factorio') return [...common, 'config/factorio-pilot.json',
    'factorio/LOCAL_DEMO.md', 'factorio/README.md', 'factorio/bridge.py', 'factorio/check-production.py',
    'factorio/check-runtime.py', 'factorio/install.sh', 'factorio/mod/agent-swarm_0.1.1', 'factorio/runtime.py',
    'factorio/scenario.lua', 'factorio/status.py', 'factorio/verify-demo.py', 'factorio/verify-live.py',
    'factorio/worker-bridge.py', 'src/factorio',
    'scripts/check-factorio.ts', 'scripts/check-factorio.py'];
  if (app === 'minecraft') return [...common, 'config/minecraft-pilot.json', 'src/minecraft',
    'scripts/check-minecraft.ts', 'scripts/check-minecraft.py'];
  return [...common, 'config/paper-pilot.example.json', 'config/risk-policy.json', 'src/agents', 'spacetimedb/src',
    'src/worker.ts', 'src/risk-worker.ts', 'src/executor.ts', 'src/alpaca-paper-adapter.ts',
    'scripts/check-phase-one.ts', 'scripts/check-research-fixture.ts'];
}

function existsAny(paths: string[]): boolean { return paths.some(path => existsSync(join(root, path))); }

function gate(status: ReadinessStatus, requirement: string, evidence: string[] = [], blockers: string[] = []): Gate {
  return { status, requirement, evidence, blockers };
}

interface LiveProof { sha256: string; artifactHashes: string[] }
function liveProof(app: ApplicationId, proofPath: string | undefined, commit: string, clean: boolean):
  { proof?: LiveProof; reason: string } {
  if (!proofPath) return { reason: 'No live acceptance evidence was supplied.' };
  try {
    const proofFile = resolve(proofPath);
    const contents = readFileSync(proofFile);
    const value = JSON.parse(contents.toString()) as Record<string, unknown>;
    if (value.schemaVersion !== 1 || value.application !== app || value.result !== 'passed' || value.commit !== commit) {
      return { reason: 'Evidence must be a passing version-1 report for this application and exact source commit.' };
    }
    if (!clean) return { reason: 'Live evidence is accepted only from a clean checkout.' };
    const completed = Array.isArray(value.completedGates) ? value.completedGates.filter((v): v is string => typeof v === 'string') : [];
    const missing = requiredLiveGates[app].filter(id => !completed.includes(id));
    if (missing.length) return { reason: `Evidence is missing required gates: ${missing.join(', ')}.` };
    const artifacts = Array.isArray(value.artifacts) ? value.artifacts : [];
    if (!artifacts.length) return { reason: 'Evidence must reference at least one hashed artifact.' };
    const hashes: string[] = [];
    for (const entry of artifacts) {
      if (!entry || typeof entry !== 'object') return { reason: 'Evidence contains an invalid artifact record.' };
      const artifact = entry as Record<string, unknown>;
      if (typeof artifact.path !== 'string' || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
        return { reason: 'Evidence artifact paths and SHA-256 hashes are required.' };
      }
      const path = resolve(dirname(proofFile), artifact.path);
      if (!existsSync(path) || !statSync(path).isFile() || hash(readFileSync(path)) !== artifact.sha256) {
        return { reason: 'An evidence artifact is missing or its SHA-256 hash does not match.' };
      }
      hashes.push(artifact.sha256);
    }
    return { proof: { sha256: hash(contents), artifactHashes: hashes }, reason: '' };
  } catch {
    return { reason: 'Live evidence could not be read or validated.' };
  }
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return await new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { cwd: root, env, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let timer: NodeJS.Timeout;
    const terminate = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch { /* already stopped */ }
    };
    timer = setTimeout(() => terminate('SIGKILL'), timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', bytes => {
      const text = String(bytes);
      output = (output + text).slice(-1_000_000);
      process.stderr.write(text);
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolveOutput(output);
      else reject(new Error(`Fixture command failed with exit ${code ?? 'signal'}`));
    });
  });
}

async function bundleTests(files: string[], outputDir: string, report: AppReport): Promise<string[]> {
  const bundles: string[] = [];
  for (const entry of files) {
    const relativePath = relative(root, entry);
    const output = join(outputDir, relativePath.replace(/\.test\.ts$/, '.test.js'));
    mkdirSync(dirname(output), { recursive: true });
    try {
      await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm',
        define: { 'import.meta.url': JSON.stringify(pathToFileURL(entry).href) } });
      report.suiteRuns.push({ command: `esbuild --bundle ${relativePath}`, status: 'passed', outputSha256: hash(readFileSync(output)) });
      bundles.push(output);
    } catch {
      report.suiteRuns.push({ command: `esbuild --bundle ${relativePath}`, status: 'failed' });
    }
  }
  return bundles;
}

function sanitizedEnv(dataDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}:${join(homedir(), '.local', 'bin')}`,
    READINESS_MODE: 'fixture', READINESS_NETWORK: 'disabled',
  };
  for (const key of Object.keys(env)) {
    if (/^(ALPACA_|ANTHROPIC_|OPENAI_|AGENT_|RUN_ID$|MAX_ORDER_NOTIONAL$)/.test(key) ||
      /(?:_SAVE|_WORLD|_PROFILE|_EULA)$/i.test(key)) delete env[key];
  }
  delete env.FACTORIO_CHECK_GAME_BIND;
  if (dataDir) env.READINESS_DATA_DIR = dataDir;
  return env;
}

function displayCommand(command: string, args: string[]): string {
  const executable = command === process.execPath ? 'node'
    : command === join(root, 'node_modules/.bin/esbuild') ? 'esbuild' : command;
  return [executable, ...args].join(' ');
}

async function fixtureRuns(app: ApplicationId, dataDir: string, report: AppReport): Promise<void> {
  const addRun = async (command: string, args: string[], timeout: number, env = sanitizedEnv(dataDir), label?: string) => {
    try {
      const output = await run(command, args, env, timeout);
      report.suiteRuns.push({ command: label ?? displayCommand(command, args), status: 'passed', outputSha256: hash(output) });
      return true;
    } catch {
      report.suiteRuns.push({ command: label ?? displayCommand(command, args), status: 'failed' });
      return false;
    }
  };
  if (app === 'factorio') {
    const unitFiles = listFiles(join(root, 'src/factorio')).filter(path => path.endsWith('.test.ts'));
    if (unitFiles.length) {
      const outputDir = join(dataDir, 'unit-tests');
      const bundles = await bundleTests(unitFiles, outputDir, report);
      if (bundles.length) await addRun(process.execPath, ['--test', ...bundles], 120_000, sanitizedEnv(dataDir),
        `node --test <${bundles.length} bundled Factorio unit tests>`);
      else report.suiteRuns.push({ command: 'node --test <bundled Factorio unit tests>', status: 'failed' });
    }
    const python = version('python3', ['--version']) ? 'python3' : undefined;
    const binary = factorioBinary();
    if (python && existsSync(binary)) {
      await addRun(python, ['factorio/check-runtime.py'], 180_000);
      await addRun(python, ['factorio/check-production.py'], 180_000);
    } else {
      report.suiteRuns.push({ command: 'python3 factorio/check-runtime.py && python3 factorio/check-production.py', status: 'not-run' });
    }
    const faultSuite = ['scripts/check-factorio.ts', 'scripts/check-factorio.py'].find(path => existsSync(join(root, path)));
    if (faultSuite) {
      const isTs = faultSuite.endsWith('.ts');
      await addRun(isTs ? process.execPath : python ?? 'python3', isTs
        ? [faultSuite, '--isolated', '--fixture', '--data-dir', dataDir]
        : [faultSuite, '--isolated', '--fixture', '--data-dir', dataDir], 300_000);
    }
  } else if (app === 'minecraft') {
    const unitFiles = listFiles(join(root, 'src/minecraft')).filter(path => path.endsWith('.test.ts'));
    if (unitFiles.length) {
      const bundles = await bundleTests(unitFiles, join(dataDir, 'unit-tests'), report);
      if (bundles.length) await addRun(process.execPath, ['--test', ...bundles], 120_000, sanitizedEnv(dataDir),
        `node --test <${bundles.length} bundled Minecraft unit tests>`);
      else report.suiteRuns.push({ command: 'node --test <bundled Minecraft unit tests>', status: 'failed' });
    }
    const suite = ['scripts/check-minecraft.ts', 'scripts/check-minecraft.py'].find(path => existsSync(join(root, path)));
    if (suite) {
      const isTs = suite.endsWith('.ts');
      await addRun(isTs ? process.execPath : 'python3', [suite, '--isolated', '--fixture', '--data-dir', dataDir], 300_000);
    }
  } else {
    await addRun(process.execPath, ['scripts/check-all.ts'], 900_000, sanitizedEnv());
  }
}

async function inspect(app: ApplicationId, options: Options, commit: string, clean: boolean, dataDir: string): Promise<AppReport> {
  const proofPath = options.evidence ?? join(root, 'reports/readiness', `${app}-live.json`);
  const proof = liveProof(app, existsSync(proofPath) ? proofPath : undefined, commit, clean);
  const unitFiles = app === 'factorio' ? listFiles(join(root, 'src/factorio')).filter(path => path.endsWith('.test.ts'))
    : app === 'minecraft' ? listFiles(join(root, 'src/minecraft')).filter(path => path.endsWith('.test.ts'))
      : listFiles(join(root, 'src')).filter(path => path.endsWith('.test.ts'));
  const integrationScript = app === 'factorio' ? ['scripts/check-factorio.ts', 'scripts/check-factorio.py']
    : app === 'minecraft' ? ['scripts/check-minecraft.ts', 'scripts/check-minecraft.py']
      : ['scripts/check-all.ts', 'scripts/check-phase-one.ts'];
  const sourceImplemented = app === 'factorio'
    ? ['factorio/runtime.py', 'src/factorio/protocol.ts', 'config/factorio-pilot.json'].every(path => existsSync(join(root, path)))
    : app === 'minecraft'
      ? existsAny(['src/minecraft', 'minecraft/server.ts', 'minecraft/server.py'])
      : ['src/worker.ts', 'spacetimedb/src/index.ts', 'src/executor.ts'].every(path => existsSync(join(root, path)));
  const integrationAvailable = integrationScript.some(path => existsSync(join(root, path)));
  const integrationBlocker = app === 'factorio' ? 'The factorio-f3-fault-suite runner is not present.'
    : app === 'minecraft' ? 'The minecraft-recovery M5 runner is not present.'
      : 'The existing paper integration runner is not present.';
  const unitPassed = reportSuitePassed(app, options, dataDir);
  const live = Boolean(proof.proof);
  const gates: AppReport['gates'] = {
    implementation: gate(readinessStatus({ implemented: sourceImplemented }),
      'Required application implementation is present.', [], sourceImplemented ? [] : ['Application implementation files are missing.']),
    unitFixtures: gate(readinessStatus({ implemented: unitFiles.length > 0, fixtureVerified: unitPassed }),
      'Application unit fixtures exist and pass when --run-fixtures is requested.', unitFiles.map(path => relative(root, path)),
      unitFiles.length ? [] : ['No application unit fixtures are available.']),
    isolatedIntegration: gate(readinessStatus({ implemented: integrationAvailable,
      fixtureVerified: options.runFixtures && reportSuitePassed(app, options, dataDir, 'integration') }),
      'Existing isolated integration/fault acceptance suite is present and passes.', integrationAvailable ? integrationScript.filter(path => existsSync(join(root, path))) : [],
      integrationAvailable ? [] : [integrationBlocker]),
    liveAcceptance: gate(readinessStatus({ implemented: false, liveVerified: live }),
      'All application live-acceptance gates have commit-matched evidence artifacts.', proof.proof ? [proof.proof.sha256] : [],
      proof.proof ? [] : [proof.reason, `Required gates: ${requiredLiveGates[app].join(', ')}.`]),
  };
  // Factorio currently has isolated real-engine fixtures, but they do not replace the F3 fault suite.
  if (app === 'factorio' && existsAny(['factorio/check-runtime.py', 'factorio/check-production.py'])) {
    const fixturePass = options.runFixtures && reportSuitePassed(app, options, dataDir, 'engine');
    const runtimeAvailable = existsSync(factorioBinary());
    gates.engineFixture = gate(readinessStatus({ implemented: runtimeAvailable, fixtureVerified: fixturePass }),
      'Run the existing disposable real-engine checks; they create only temporary worlds.',
      ['factorio/check-runtime.py', 'factorio/check-production.py'], fixturePass ? []
        : [runtimeAvailable ? 'Fixture was not run.' : 'Pinned Factorio binary is missing.']);
  }
  const preflightResult = preflight(app);
  const preflightReady = preflightResult.checks.every(item => item.status === 'available');
  const suitesAvailable = Object.entries(gates).filter(([name]) => name !== 'liveAcceptance')
    .every(([, item]) => item.status !== 'blocked');
  const overall = preflightReady && suitesAvailable ? releaseStatus([gates.liveAcceptance.status]) : 'blocked';
  const runRecords = latestRuns.get(app) ?? [];
  return { application: app, releaseStatus: overall, gates, preflight: preflightResult,
    hashes: hashPaths(sourcePaths(app)), suiteRuns: runRecords,
    ...(proof.proof ? { liveEvidence: proof.proof } : {}) };
}

const latestRuns = new Map<ApplicationId, AppReport['suiteRuns']>();
function reportSuitePassed(app: ApplicationId, options: Options, _dataDir: string, category?: 'integration' | 'engine'): boolean {
  if (!options.runFixtures) return false;
  const runs = latestRuns.get(app) ?? [];
  const selected = category === 'engine' ? runs.filter(row => /factorio\/check-(runtime|production)\.py/.test(row.command))
    : category === 'integration' ? runs.filter(row => /scripts\/check-(factorio|minecraft)\.(ts|py)|scripts\/check-all\.ts/.test(row.command))
      : runs.filter(row => !/factorio\/check-(runtime|production)\.py/.test(row.command));
  return selected.length > 0 && selected.every(row => row.status === 'passed');
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    process.stdout.write('Usage: node scripts/check-all.ts --app factorio|minecraft|paper|all [--dry-run|--run-fixtures] [--evidence FILE]\n');
    process.stdout.write('Dry-run is the default. It never starts apps, accepts EULAs, calls models, contacts Alpaca, or writes saves.\n');
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Readiness checks require Node.js 24 or newer.');
  const commitResult = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const commit = commitResult.status === 0 ? commitResult.stdout.trim() : 'unknown';
  const statusResult = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const clean = statusResult.status === 0 && statusResult.stdout.trim().length === 0;
  const dataDir = parsed.runFixtures ? mkdtempSync(join(tmpdir(), 'agent-swarm-readiness-')) : '';
  const output: Record<string, unknown> = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    commit,
    workingTreeClean: clean,
    mode: parsed.runFixtures ? 'isolated-fixtures' : 'dry-run',
    runtime: { node: process.versions.node, platform: process.platform, architecture: process.arch,
      spacetimeCli: version(cli, ['--version']) ?? null, java: version('java', ['-version']) ?? null },
    externalNetworkAccess: 'not attempted; fixture runs remove model and broker credentials',
    applications: [],
  };
  let blocked = false;
  try {
    const reports: AppReport[] = [];
    for (const app of parsed.selected) {
      const report: AppReport = {
        application: app, releaseStatus: 'blocked', gates: {}, preflight: preflight(app), hashes: hashPaths(sourcePaths(app)), suiteRuns: [],
      };
      if (parsed.runFixtures) {
        const appDataDir = join(dataDir, app);
        const mkdir = await import('node:fs/promises');
        await mkdir.mkdir(appDataDir, { recursive: true });
        const before = report.suiteRuns.length;
        await fixtureRuns(app, appDataDir, report);
        latestRuns.set(app, report.suiteRuns.slice(before));
      }
      const inspected = await inspect(app, parsed, commit, clean, dataDir);
      inspected.suiteRuns = report.suiteRuns;
      // Bind fixture status to the commands that actually ran in this invocation.
      const passed = (pattern: RegExp) => report.suiteRuns.some(row => pattern.test(row.command)) &&
        report.suiteRuns.filter(row => pattern.test(row.command)).every(row => row.status === 'passed');
      if (app === 'factorio') {
        if (passed(/node --test|(?:protocol|operation-journal)\.test\.ts/)) inspected.gates.unitFixtures.status = 'fixture-verified';
        if (passed(/factorio\/check-(runtime|production)\.py/)) inspected.gates.engineFixture!.status = 'fixture-verified';
        if (passed(/scripts\/check-factorio\.(ts|py)/)) inspected.gates.isolatedIntegration.status = 'fixture-verified';
      } else if (app === 'minecraft') {
        if (passed(/node --test|\.test\.ts/)) inspected.gates.unitFixtures.status = 'fixture-verified';
        if (passed(/scripts\/check-minecraft\.(ts|py)/)) inspected.gates.isolatedIntegration.status = 'fixture-verified';
      } else if (passed(/scripts\/check-all\.ts/)) {
        inspected.gates.unitFixtures.status = 'fixture-verified';
        inspected.gates.isolatedIntegration.status = 'fixture-verified';
      }
      if (inspected.gates.liveAcceptance.status !== 'live-verified') inspected.releaseStatus = 'blocked';
      reports.push(inspected);
      if (inspected.releaseStatus === 'blocked' || Object.values(inspected.gates).some(item => item.status === 'blocked')) blocked = true;
    }
    output.applications = reports;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (blocked) process.exitCode = 2;
  } finally {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
