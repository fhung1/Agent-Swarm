import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { context } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { findBoard } from '../message-board/config.ts';
import { loadBoardConfig } from '../message-board/load-config.ts';

const config = loadBoardConfig();
const portfolio = process.argv.includes('--portfolio');
const boardIndex = process.argv.indexOf('--board');
const board = findBoard(config, boardIndex < 0 ? config.defaultBoard : process.argv[boardIndex + 1] ?? '');
const host = process.env.SPACETIMEDB_HOST ?? 'ws://127.0.0.1:3000';
if (!['ws:', 'wss:'].includes(new URL(host).protocol)) throw new Error('SPACETIMEDB_HOST must use ws:// or wss://');
const port = Number(process.env.DASHBOARD_PORT ?? (portfolio ? 4173 : 4175));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DASHBOARD_PORT');
const mode = portfolio ? 'portfolio' : 'communication';
const factorioEnabled = !portfolio && board.id === 'factorio';
const directory = resolve(`dashboard/dist/${mode}-${port}`);
const worldDirectory = process.env.FACTORIO_WORLD ? resolve(process.env.FACTORIO_WORLD) : undefined;
const controlToken = process.env.FACTORIO_CONTROL_TOKEN ?? '';
if (controlToken && controlToken.length < 32) throw new Error('FACTORIO_CONTROL_TOKEN must be at least 32 characters');
const configuredRunId = process.env.FACTORIO_RUN_ID;
if (configuredRunId && !/^[a-z0-9_.-]{1,36}$/.test(configuredRunId)) throw new Error('Invalid FACTORIO_RUN_ID');
const execFileAsync = promisify(execFile);

await mkdir(directory, { recursive: true });
const html = (await readFile('dashboard/index.html', 'utf8'))
  .replace('/dist/app.js', '/app.js')
  .replace('Paper Console', portfolio ? 'Paper Console' : 'Agent Communication')
  .replace('<html lang="en">', `<html lang="en" data-boards="${encodeURIComponent(JSON.stringify(config))}" data-board="${board.id}" data-host="${encodeURIComponent(host)}">`);
await writeFile(join(directory, 'index.html'), html);
const copyStyle = async () => writeFile(join(directory, 'style.css'), await readFile('dashboard/style.css'));
await copyStyle();
const styleWatcher = watch('dashboard/style.css', () => { void copyStyle().catch(console.error); });

const build = await context({
  entryPoints: [portfolio ? 'dashboard/app.ts' : 'dashboard/board-app.ts'], bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
  outfile: join(directory, 'app.js'), logLevel: 'info',
});
await build.watch();

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readRequestJson(request) {
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw Object.assign(new Error('Expected application/json'), { statusCode: 415 });
  }
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 4096) throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
  }
  try { return JSON.parse(body); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }); }
}

function readLatestRun(game) {
  if (!worldDirectory) return undefined;
  const runsDirectory = join(worldDirectory, 'inference');
  if (!existsSync(runsDirectory)) return undefined;
  let ids;
  try { ids = configuredRunId ? [configuredRunId] : readdirSync(runsDirectory).filter(id => /^[a-z0-9_.-]{1,36}$/.test(id)); }
  catch { return undefined; }
  const candidates = [];
  for (const id of ids) {
    const planPath = join(runsDirectory, id, 'plan.json');
    try {
      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      if (plan.runId !== id || plan.worldId !== game.world?.worldId || plan.historyId !== game.world?.historyId ||
          !['plates', 'rocket'].includes(plan.goal) || typeof plan.provider !== 'string' || typeof plan.model !== 'string' ||
          !Array.isArray(plan.workers)) continue;
      const workers = plan.workers.filter(worker => worker && Number.isSafeInteger(worker.index) && Number.isSafeInteger(worker.actorId) &&
        typeof worker.sender === 'string' && typeof worker.taskId === 'string')
        .map(worker => ({ index: worker.index, actorId: worker.actorId, sender: worker.sender, taskId: worker.taskId }));
      let spend;
      const spendPath = join(runsDirectory, id, 'run-spend.json');
      if (existsSync(spendPath)) {
        const ledger = JSON.parse(readFileSync(spendPath, 'utf8'));
        if (ledger.version === 1 && ledger.runId === id && ledger.worldId === game.world.worldId && ledger.historyId === game.world.historyId &&
            typeof ledger.capMicros === 'string' && /^\d+$/.test(ledger.capMicros) && ledger.records && typeof ledger.records === 'object') {
          let charged = 0n, reserved = 0n;
          for (const record of Object.values(ledger.records)) {
            if (record.status === 'settled' && /^\d+$/.test(record.chargedMicros)) charged += BigInt(record.chargedMicros);
            else if (record.status === 'reserved' && /^\d+$/.test(record.reservedMicros)) reserved += BigInt(record.reservedMicros);
          }
          const usd = micros => `$${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, '0')}`;
          spend = { capUsd: usd(BigInt(ledger.capMicros)), chargedUsd: usd(charged), reservedUsd: usd(reserved),
            remainingUsd: usd(BigInt(ledger.capMicros) - charged - reserved), halted: Boolean(ledger.halted) };
        }
      }
      let overseer = null;
      const overseerPath = join(runsDirectory, id, 'orchestrator-state.json');
      if (existsSync(overseerPath)) {
        try {
          const state = JSON.parse(readFileSync(overseerPath, 'utf8'));
          const sections = Object.entries(state.plan ?? {}).filter(([name, entry]) =>
            /^[a-z0-9_-]{1,40}$/.test(name) && entry && typeof entry.content === 'string')
            .slice(0, 20).map(([name, entry]) => ({ name, content: entry.content.slice(0, 1700),
              revision: Number.isSafeInteger(entry.revision) ? entry.revision : 0,
              updatedTick: Number.isSafeInteger(entry.updatedTick) ? entry.updatedTick : 0 }));
          const decisions = Array.isArray(state.recentDecisions) ? state.recentDecisions.slice(-8).filter(row => row &&
            Number.isSafeInteger(row.call) && typeof row.kind === 'string').map(row => ({
              call: row.call, tick: Number.isSafeInteger(row.tick) ? row.tick : null,
              kind: row.kind.slice(0, 30), recipient: typeof row.recipient === 'string' ? row.recipient.slice(0, 80) : '',
              message: typeof row.message === 'string' ? row.message.slice(0, 400) : '',
              title: typeof row.title === 'string' ? row.title.slice(0, 90) : '',
            })) : [];
          overseer = { calls: Number.isSafeInteger(state.calls) ? state.calls : 0,
            updatedAt: new Date(statSync(overseerPath).mtimeMs).toISOString(), sections, decisions };
        } catch { /* A concurrent journal write can be retried on the next status refresh. */ }
      }
      candidates.push({ modifiedAt: statSync(planPath).mtimeMs, run: {
        runId: id, goal: plan.goal, provider: plan.provider, model: plan.model,
        mode: typeof plan.mode === 'string' ? plan.mode : 'unknown',
        maxCalls: Number.isSafeInteger(plan.maxCalls) ? plan.maxCalls : null,
        totalCallLimit: Number.isSafeInteger(plan.totalCallLimit) ? plan.totalCallLimit : null,
        runMs: Number.isSafeInteger(plan.runMs) ? plan.runMs : null,
        maxRunSpendUsd: typeof plan.maxRunSpendUsd === 'string' ? plan.maxRunSpendUsd : null, spend: spend ?? null,
        workers, overseer,
      } });
    } catch { /* Ignore incomplete or unreadable plans; the live game status remains useful. */ }
  }
  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return candidates[0]?.run;
}

async function factorioStatus() {
  if (!factorioEnabled) throw Object.assign(new Error('Factorio dashboard is not enabled'), { statusCode: 404 });
  if (!worldDirectory) throw Object.assign(new Error('Set FACTORIO_WORLD to the active world directory'), { statusCode: 503 });
  const { stdout } = await execFileAsync('python3', ['factorio/status.py', '--world', worldDirectory], {
    cwd: process.cwd(), timeout: 10000, maxBuffer: 1024 * 1024,
  });
  const game = JSON.parse(stdout);
  if (!game || !Number.isSafeInteger(game.tick) || typeof game.paused !== 'boolean' || !game.world ||
      typeof game.world.worldId !== 'string' || typeof game.world.historyId !== 'string' || !Array.isArray(game.actors)) {
    throw new Error('Invalid Factorio status received from the game');
  }
  return { checkedAt: new Date().toISOString(), controlsEnabled: Boolean(controlToken), game, run: readLatestRun(game) ?? null };
}

function authorizedForControl(request) {
  if (!controlToken) return false;
  const supplied = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${controlToken}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function handleApi(request, response) {
  if (!factorioEnabled) { sendJson(response, 404, { error: 'Factorio dashboard is not enabled' }); return true; }
  if (request.method === 'GET' && request.url === '/api/factorio/status') {
    try { sendJson(response, 200, await factorioStatus()); }
    catch (error) { sendJson(response, error.statusCode ?? 503, { error: `Factorio status unavailable: ${String(error.message ?? error).slice(0, 300)}` }); }
    return true;
  }
  if (request.method === 'POST' && request.url === '/api/factorio/control') {
    try {
      if (!controlToken) { sendJson(response, 503, { error: 'Operator controls are disabled; configure FACTORIO_CONTROL_TOKEN' }); return true; }
      if (!authorizedForControl(request)) { sendJson(response, 403, { error: 'Operator control token is missing or invalid' }); return true; }
      const command = await readRequestJson(request);
      if (!command || Array.isArray(command) || typeof command !== 'object' || Object.keys(command).length !== 1 || typeof command.paused !== 'boolean') {
        sendJson(response, 400, { error: 'Expected exactly {paused: boolean}' }); return true;
      }
      if (!worldDirectory) { sendJson(response, 503, { error: 'Set FACTORIO_WORLD to the active world directory' }); return true; }
      const action = command.paused ? '--pause' : '--resume';
      const { stdout } = await execFileAsync('python3', ['factorio/status.py', '--world', worldDirectory, action], {
        cwd: process.cwd(), timeout: 10000, maxBuffer: 1024 * 1024,
      });
      sendJson(response, 200, JSON.parse(stdout));
    } catch (error) {
      sendJson(response, error.statusCode ?? 503, { error: `Factorio control failed: ${String(error.message ?? error).slice(0, 300)}` });
    }
    return true;
  }
  return false;
}

const contentTypes = { '/': 'text/html; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8', '/style.css': 'text/css; charset=utf-8' };
const server = createServer(async (request, response) => {
  try {
    if (await handleApi(request, response)) return;
    const path = request.url?.split('?', 1)[0] ?? '';
    const contentType = contentTypes[path];
    if (request.method !== 'GET' || !contentType) { response.writeHead(404); response.end('Not found'); return; }
    const filePath = path === '/' ? join(directory, 'index.html') : join(directory, path.slice(1));
    response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
    response.end(readFileSync(filePath));
  } catch (error) {
    if (!response.headersSent) { response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); response.end('Dashboard request failed'); }
    console.error(error);
  }
});
server.listen(port, process.env.DASHBOARD_HOST ?? '127.0.0.1', () => {
  console.log(`${portfolio ? 'Paper portfolio console' : 'Agent communication dashboard'} (${portfolio ? 'quant-swarm' : board.database}): http://${server.address().address}:${port}${portfolio ? '' : `/?board=${board.id}`}`);
  if (factorioEnabled) console.log(worldDirectory ? 'Factorio world status enabled' : 'Set FACTORIO_WORLD to enable Factorio status and operator controls');
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  styleWatcher.close(); server.close(); void build.dispose().then(() => process.exit(0));
});
