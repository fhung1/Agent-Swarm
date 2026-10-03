#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real browser + local reducers. All state, tokens, keys and ports are temporary.
// No provider or broker calls; the order/fill below is a labeled local ledger fixture.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = process.env.SPACETIME_CLI ?? 'spacetime';
const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${process.env.PATH ?? ''}:${join(homedir(), '.local', 'bin')}` };
for (const key of Object.keys(env)) if (/^(ALPACA_|ANTHROPIC_|OPENAI_|AGENT_|COORD_|SPACETIME_|SPACETIMEDB_|DASHBOARD_)/.test(key)) delete env[key];
const chrome = process.env.CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => existsSync(path));
if (!chrome) throw new Error('Install Chrome/Chromium or set CHROME_PATH to its executable.');
if (!existsSync(chrome)) throw new Error(`Chrome executable does not exist: ${chrome}`);
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('check-dashboard requires Node.js 24 or newer.');
const directory = mkdtempSync(join(tmpdir(), 'quant-dashboard-check-'));
const snapshot = join(directory, 'repo');
const config = join(directory, 'cli.toml');
const database = 'dashboard-check';
const children = new Set<ChildProcess>();
const logs = new Map<ChildProcess, string>();
let browserSocket: WebSocket | undefined;
let server: ChildProcess | undefined;
let stopping = false;
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

function launch(command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(command, args, { cwd: snapshot, env: { ...env, ...extraEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); logs.set(child, '');
  child.on('error', error => logs.set(child, String(error)));
  for (const stream of [child.stdout!, child.stderr!]) stream.on('data', bytes => logs.set(child, (logs.get(child)! + String(bytes)).slice(-8000)));
  return child;
}
async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  const finished = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(done => child.once('close', () => done()));
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
  const force = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already stopped. */ } }, 2000);
  await finished; clearTimeout(force);
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* No grandchildren. */ }
  children.delete(child);
}
function run(command: string, args: string[], label: string): string {
  try { return execFileSync(command, args, { cwd: snapshot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }); }
  catch (error) {
    if (label === 'publisher login') throw new Error(`${label} failed`);
    throw new Error(`${label} failed: ${String((error as { stderr?: Buffer }).stderr ?? error)}`);
  }
}
function cliRun(args: string[], label: string): string { return run(cli, ['--config-path', config, ...args], label); }
async function port(): Promise<number> {
  return await new Promise((done, reject) => {
    const listener = createServer(); listener.on('error', reject);
    listener.listen(0, '127.0.0.1', () => { const address = listener.address(); assert.ok(address && typeof address !== 'string'); listener.close(() => done(address.port)); });
  });
}
async function waitFor(check: () => unknown | Promise<unknown>, label: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (stopping || Date.now() > deadline) throw new Error(`Timed out: ${label}`); await delay(100); }
}
const stamp = (offset = 0) => ({ __timestamp_micros_since_unix_epoch__: (Date.now() + offset) * 1000 });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  stopping = true;
  for (const child of children) if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ } }
});

try {
  // Capture module and dashboard together, then generate bindings against that captured schema.
  // Build/publish never writes the live module's build directory or the shared CLI configuration.
  cpSync(join(root, 'spacetimedb'), join(snapshot, 'spacetimedb'), { recursive: true, filter: path => !/(?:^|\/)(node_modules|build)(?:\/|$)/.test(path) });
  cpSync(join(root, 'dashboard'), join(snapshot, 'dashboard'), { recursive: true, filter: path => !/(?:^|\/)(node_modules|dist)(?:\/|$)/.test(path) });
  cpSync(join(root, 'tsconfig.json'), join(snapshot, 'tsconfig.json'));
  cpSync(join(root, 'package.json'), join(snapshot, 'package.json'));
  symlinkSync(join(root, 'node_modules'), join(snapshot, 'node_modules'), 'dir');
  const version = cliRun(['--version'], 'CLI version');
  if (!/spacetimedb tool version 2\.10\.2;/.test(version)) throw new Error('This check requires SpacetimeDB CLI 2.10.2.');
  const dbPort = await port(); const dashboardPort = await port(); const browserPort = await port();
  const origin = `http://127.0.0.1:${dbPort}`;
  const url = `http://127.0.0.1:${dashboardPort}`;
  const privateKey = join(directory, 'id_ecdsa'); const publicKey = join(directory, 'id_ecdsa.pub');
  run('openssl', ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-out', privateKey], 'temporary JWT key');
  chmodSync(privateKey, 0o600);
  run('openssl', ['ec', '-in', privateKey, '-pubout', '-out', publicKey], 'temporary public key');
  const startServer = async () => {
    server = launch(cli, ['--config-path', config, 'start', '--listen-addr', `127.0.0.1:${dbPort}`, '--data-dir', join(directory, 'data'),
      '--jwt-priv-key-path', privateKey, '--jwt-pub-key-path', publicKey, '--non-interactive']);
    await waitFor(async () => {
      if (server!.exitCode !== null) throw new Error(`Temporary server exited: ${logs.get(server!)}`);
      try { return (await fetch(`${origin}/v1/ping`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, 'isolated database start', 30_000);
  };
  await startServer();
  const identityResponse = await fetch(`${origin}/v1/identity`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  assert.ok(identityResponse.ok);
  const publisher = await identityResponse.json() as { token: string; identity: string };
  cliRun(['login', '--token', publisher.token], 'publisher login');
  console.log('[dashboard] Build and publish isolated fixture module');
  cliRun(['publish', '--module-path', 'spacetimedb', '--server', origin, '--no-config', '--yes', database], 'publish isolated module');
  cliRun(['generate', '--lang', 'typescript', '--module-path', 'spacetimedb', '--out-dir', 'src/module_bindings', '--no-config', '--yes'], 'fixture bindings');
  const call = (reducer: string, ...args: unknown[]) => cliRun(['call', '--server', origin, database, reducer, ...args.map(value => JSON.stringify(value))], reducer);
  const role = (name: string) => call('grant_agent', publisher.identity, name);
  const runId = 'browser-fixture'; const accountId = 'browser-paper'; const symbol = 'QBROWSER';
  const hostile = '<img src=x onerror="window.__hostile=true">HOSTILE-TEXT';
  const sourceId = 'browser-source'; const factId = 'browser-fact'; const unsafeId = 'browser-unsafe-source';
  const thesisId = 'browser-thesis'; const decisionId = 'browser-decision'; const proposalId = 'browser-proposal';
  const policyId = 'browser-policy'; const snapshotId = 'browser-account'; const quoteId = 'browser-quote'; const orderId = 'browser-order';
  const policy = { version: policyId, allowedSymbols: [symbol], longOnly: true, maxOrderNotional: 1000, maxPositionNotional: 5000,
    maxQuoteAgeMs: 120000, maxAccountAgeMs: 120000, maxLimitDeviation: 0.05, approvalTtlMs: 120000, maxProposalAgeMs: 900000,
    requireMarketOpen: true, maxPortfolioNotional: 10000, maxOpenOrders: 5 };
  role('operator');
  call('create_run', runId, 'Synthetic browser acceptance; no broker request');
  call('grant_run_access', publisher.identity, runId);
  call('grant_account_access', publisher.identity, accountId);
  call('add_risk_policy', policyId, runId, accountId, JSON.stringify(policy));
  role('ingestor');
  call('add_source', sourceId, runId, symbol, 'fixture', 'https://example.invalid/filing', stamp(), 'fixture-checksum', 'fixture-only');
  call('add_source', unsafeId, runId, symbol, 'fixture', 'javascript:window.__hostile=true', stamp(), 'fixture-checksum', 'fixture-only');
  call('add_fact', factId, sourceId, symbol, 'Fixture revenue', '123456', 'USD', 'fixture-period', 'synthetic');
  role('analyst');
  call('publish_thesis', thesisId, runId, '', symbol, hostile, 'Fixture counterargument', 'Synthetic assumption', 'Fixture invalidation', `${sourceId},${factId},${unsafeId}`);
  role('market_data');
  call('record_account_snapshot', snapshotId, accountId, 'ACTIVE', '12345.67', '12345.67', '20000', '[]', '[]',
    [{ id: quoteId, symbol, feed: 'iex', bid_price: '99', ask_price: '100', bid_size: '1', ask_size: '1', as_of: stamp() }]);
  const clock = stamp(); call('record_market_clock', accountId, true, clock);
  role('coordinator');
  call('post_message', 'browser-critique', runId, '', symbol, 'coordinator', 'challenge', 'Synthetic skeptic objection', thesisId);
  call('record_decision_input', decisionId, runId, thesisId, quoteId, 'browser-critique', 'fixture-model', 'fixture-v1', policyId, '1000');
  call('record_decision', decisionId, thesisId, 'trade', 'Synthetic traceable decision; no real trade');
  call('propose_trade', proposalId, runId, thesisId, symbol, 'buy', '2', 'market', '');
  role('risk');
  call('record_risk_decision', 'browser-risk', proposalId, policyId, 'pass', '', stamp(90_000), snapshotId, clock);
  role('operator');

  const web = launch(process.execPath, ['dashboard/server.mjs'], { SPACETIMEDB_HOST: `ws://127.0.0.1:${dbPort}`, SPACETIMEDB_DB_NAME: database, DASHBOARD_PORT: String(dashboardPort) });
  await waitFor(async () => {
    if (web.exitCode !== null) throw new Error(`Dashboard exited: ${logs.get(web)}`);
    try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  }, 'isolated dashboard start');
  const browser = launch(chrome, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${join(directory, 'browser-profile')}`, `--remote-debugging-port=${browserPort}`, '--remote-debugging-address=127.0.0.1', 'about:blank']);
  let target: { webSocketDebuggerUrl: string } | undefined;
  await waitFor(async () => {
    if (browser.exitCode !== null) throw new Error(`Chrome exited: ${logs.get(browser)}`);
    try { target = ((await (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>).find(tab => tab.type === 'page'); } catch { /* Starting. */ }
    return target;
  }, 'Chrome debugger');
  browserSocket = new WebSocket(target!.webSocketDebuggerUrl);
  await new Promise<void>((done, reject) => { browserSocket!.onopen = () => done(); browserSocket!.onerror = () => reject(new Error('Chrome debugging connection failed')); });
  let sequence = 0;
  const requests = new Map<number, { done: (value: any) => void; reject: (reason: Error) => void }>();
  const exceptions: unknown[] = [];
  browserSocket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    const request = requests.get(message.id);
    if (request) { requests.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.done(message.result); }
  };
  const send = (method: string, params: object = {}): Promise<any> => new Promise((done, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { requests.delete(id); reject(new Error(`Chrome command timed out: ${method}`)); }, 10_000);
    requests.set(id, { done: value => { clearTimeout(timeout); done(value); }, reject: reason => { clearTimeout(timeout); reject(reason); } });
    browserSocket!.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${result.exceptionDetails.text}`);
    return result.result.value as T;
  };
  const body = () => evaluate<string>('document.body.innerText');
  const visible = (text: string) => waitFor(async () => (await body()).includes(text), `visible ${text}`);
  const absent = (text: string) => waitFor(async () => !(await body()).includes(text), `hidden ${text}`);
  const orderStatus = (status: string) => waitFor(() => evaluate<boolean>(
    `Array.from(document.querySelectorAll('.order-detail .field-value')).some(element => element.textContent === ${JSON.stringify(`${status} · browser-client-order`)})`,
  ), `exact order status ${status}`);
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url });
  await visible('Waiting for an operator grant');
  const browserIdentity = await evaluate<string>("document.querySelector('.gate-card .field-value').textContent");
  assert.match(browserIdentity, /^[a-f0-9]{64}$/);
  assert.equal(await evaluate<number>("document.querySelectorAll('.run-item,.account-grid,.research-card,.order-detail').length"), 0);
  await absent(runId); await absent('12345.67');
  console.log('PASS fresh ungranted browser sees no run, evidence, account or order rows');
  call('grant_agent', browserIdentity, 'operator');
  await visible(runId); await visible('No account snapshot is visible'); await absent('12345.67');
  call('grant_account_access', browserIdentity, accountId);
  await visible('12345.67'); await visible('Fixture counterargument'); await visible('Synthetic traceable decision');
  await visible('Frozen inputs'); await visible('fixture-model'); await visible('browser-policy');
  await evaluate("document.querySelector('.evidence-details').open = true");
  await visible('Fixture revenue: 123456 USD');
  assert.equal(await evaluate<string>("document.querySelector('a.evidence-link').getAttribute('href')"), 'https://example.invalid/filing');
  assert.equal(await evaluate<number>("document.querySelectorAll('a[href^=\"javascript:\"],.case img').length"), 0);
  assert.equal(await evaluate<boolean>('window.__hostile === true'), false);
  await visible(hostile); await visible('PASS');
  console.log('PASS live grants, source/fact/decision/frozen-input/risk trace and safe hostile text/URL rendering');

  call('create_task', 'browser-live-task', runId, symbol, 'research', 'LIVE-TASK-OBJECTIVE', 'analyst', '');
  call('post_message', 'browser-live-message', runId, 'browser-live-task', symbol, '', 'observation', `LIVE-MESSAGE ${hostile}`, sourceId);
  await visible('LIVE-TASK-OBJECTIVE'); await visible('LIVE-MESSAGE');
  role('executor');
  call('reserve_paper_order', orderId, proposalId, 'browser-client-order');
  await orderStatus('submitting');
  call('update_paper_order', orderId, 'fixture-broker-id', 'accepted');
  await orderStatus('accepted');
  assert.equal(await evaluate<number>("[...document.querySelectorAll('.order-detail .field-label')].filter(el=>el.textContent==='Fill').length"), 0);
  call('record_fill', 'browser-fill-one', orderId, 'fixture-activity-one', '1', '100', stamp());
  call('update_paper_order', orderId, 'fixture-broker-id', 'partially_filled');
  await orderStatus('partially_filled'); await visible('fixture-activity-one');
  call('record_fill', 'browser-fill-two', orderId, 'fixture-activity-two', '1', '100', stamp());
  call('update_paper_order', orderId, 'fixture-broker-id', 'filled');
  await orderStatus('filled'); await visible('fixture-activity-two');
  role('operator');
  console.log('PASS live task/message/order/partial-fill/fill updates; accepted order has no fill');

  await evaluate("[...document.querySelectorAll('button')].find(el=>el.textContent==='Pause run').click()");
  await visible('Resume run');
  assert.match(cliRun(['sql', '--server', origin, database, `SELECT status FROM run WHERE id = '${runId}'`], 'paused reducer state'), /paused/);
  await evaluate("[...document.querySelectorAll('button')].find(el=>el.textContent==='Resume run').click()");
  await visible('Pause run');
  assert.match(cliRun(['sql', '--server', origin, database, `SELECT status FROM run WHERE id = '${runId}'`], 'active reducer state'), /active/);
  assert.equal(await evaluate<boolean>("[...document.querySelectorAll('button')].find(el=>el.textContent==='Cancel order').disabled"), true);
  console.log('PASS pause/resume reducers commit; cancellation remains disabled pending its workflow');
  const tokenKey = `quant-swarm:dashboard:token:ws://127.0.0.1:${dbPort}:${database}`;
  const token = await evaluate<string>(`localStorage.getItem(${JSON.stringify(tokenKey)})`);
  assert.ok(token);
  await send('Page.reload'); await visible('fixture-activity-two');
  assert.equal(await evaluate<string>(`localStorage.getItem(${JSON.stringify(tokenKey)})`), token);
  await stop(server!); await visible('Reconnecting');
  await startServer(); await visible('fixture-activity-two');
  assert.equal(await evaluate<string>(`localStorage.getItem(${JSON.stringify(tokenKey)})`), token);
  console.log('PASS reload and actual server disconnect/restart retain identity and restore subscribed rows');
  call('revoke_account_access', browserIdentity, accountId);
  await absent('12345.67'); await absent('fixture-broker-id'); await absent('fixture-activity-one');
  await visible('No account snapshot is visible');
  call('revoke_agent', browserIdentity);
  await visible('Waiting for an operator grant');
  await absent(runId); await absent('LIVE-MESSAGE'); await absent('Fixture counterargument');
  assert.equal(await evaluate<number>("document.querySelectorAll('.run-item,.account-grid,.research-card,.order-detail').length"), 0);
  assert.equal(exceptions.length, 0, `Browser runtime exceptions: ${JSON.stringify(exceptions)}`);
  console.log('PASS live account and operator revocation remove protected rows; no runtime exceptions');
  console.log('[dashboard] All browser acceptance checks passed (synthetic local ledger, no Alpaca/model calls).');
} finally {
  browserSocket?.close();
  await Promise.all([...children].map(stop));
  rmSync(directory, { recursive: true, force: true });
}
