import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const delay = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));
export const stamp = (offset = 0) => ({ __timestamp_micros_since_unix_epoch__: (Date.now() + offset) * 1000 });
export async function waitFor(check: () => unknown | Promise<unknown>, label: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await delay(100); }
}
async function port(): Promise<number> {
  return await new Promise((done, reject) => {
    const listener = createServer(); listener.on('error', reject);
    listener.listen(0, '127.0.0.1', () => { const address = listener.address(); assert.ok(address && typeof address !== 'string'); listener.close(() => done(address.port)); });
  });
}

// Each page uses the real Chrome DevTools protocol, with bounded requests and captured exceptions.
export class BrowserPage {
  readonly exceptions: unknown[] = [];
  promptReply: string | undefined;
  private sequence = 0;
  private readonly socket: WebSocket;
  private readonly requests = new Map<number, { done: (value: any) => void; reject: (reason: Error) => void }>();
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.exceptionThrown') this.exceptions.push(message.params.exceptionDetails);
      if (message.method === 'Page.javascriptDialogOpening') {
        if (this.promptReply === undefined) this.exceptions.push(`Unexpected dialog: ${message.params.type}`);
        void this.send('Page.handleJavaScriptDialog', { accept: this.promptReply !== undefined, promptText: this.promptReply ?? '' })
          .catch(reason => this.exceptions.push(String(reason)));
      }
      const request = this.requests.get(message.id);
      if (request) { this.requests.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.done(message.result); }
    };
    socket.onclose = () => { for (const request of this.requests.values()) request.reject(new Error('Chrome page closed')); this.requests.clear(); };
  }
  static async connect(uri: string): Promise<BrowserPage> {
    const socket = new WebSocket(uri);
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error('Chrome debugging connection timed out')); }, 10_000);
      socket.onopen = () => { clearTimeout(timeout); done(); };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('Chrome debugging connection failed')); };
    });
    const page = new BrowserPage(socket);
    await page.send('Runtime.enable'); await page.send('Page.enable');
    return page;
  }
  send(method: string, params: object = {}): Promise<any> {
    return new Promise((done, reject) => {
      const id = ++this.sequence;
      const timeout = setTimeout(() => { this.requests.delete(id); reject(new Error(`Chrome command timed out: ${method}`)); }, 10_000);
      this.requests.set(id, { done: value => { clearTimeout(timeout); done(value); }, reject: reason => { clearTimeout(timeout); reject(reason); } });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate<T = unknown>(expression: string): Promise<T> {
    // Chromium pauses animation frames in background tabs; activate the tab before checking its UI.
    await this.send('Page.bringToFront');
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${result.exceptionDetails.text}`);
    return result.result.value as T;
  }
  body(): Promise<string> { return this.evaluate<string>("document.body?.innerText ?? ''"); }
  async visible(text: string): Promise<void> {
    try { await waitFor(async () => (await this.body()).includes(text), `visible ${text}`); }
    catch (error) { throw new Error(`${String(error)}\nBrowser text: ${await this.body()}\nExceptions: ${JSON.stringify(this.exceptions)}`); }
  }
  absent(text: string): Promise<void> { return waitFor(async () => !(await this.body()).includes(text), `hidden ${text}`); }
  close(): void { this.socket.close(); }
}

// Every instance captures source and owns temporary module, server, CLI config, keys and browser profile.
export class DashboardTestEnv {
  readonly database: string;
  origin = '';
  url = '';
  publisher = { identity: '', token: '' };
  tokenKey = '';
  private readonly root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  private readonly cli = process.env.SPACETIME_CLI ?? 'spacetime';
  private readonly env: NodeJS.ProcessEnv = { ...process.env, PATH: `${process.env.PATH ?? ''}:${join(homedir(), '.local', 'bin')}` };
  private readonly directory: string;
  private readonly snapshot: string;
  private readonly config: string;
  private readonly chrome: string;
  private readonly mode: 'trading' | 'development';
  private readonly children = new Set<ChildProcess>();
  private readonly logs = new Map<ChildProcess, string>();
  private readonly pages: BrowserPage[] = [];
  private server: ChildProcess | undefined;
  private browser: ChildProcess | undefined;
  private dbPort = 0;
  private dashboardPort = 0;
  private browserPort = 0;
  private webStarted = false;
  private stopped = false;
  private readonly interrupt = () => {
    this.stopped = true;
    for (const child of this.children) if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ } }
  };
  private constructor(mode: 'trading' | 'development') {
    this.mode = mode;
    const chrome = process.env.CHROME_PATH ?? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    ].find(path => existsSync(path));
    if (!chrome) throw new Error('Install Chrome/Chromium or set CHROME_PATH to its executable.');
    if (!existsSync(chrome)) throw new Error(`Chrome executable does not exist: ${chrome}`);
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Dashboard checks require Node.js 24 or newer.');
    this.chrome = chrome;
    for (const key of Object.keys(this.env)) if (/^(ALPACA_|ANTHROPIC_|OPENAI_|AGENT_|COORD_|SPACETIME_|SPACETIMEDB_|DASHBOARD_)/.test(key)) delete this.env[key];
    this.database = mode === 'trading' ? 'dashboard-check' : 'dev-dashboard-check';
    this.directory = mkdtempSync(join(tmpdir(), 'quant-dashboard-check-'));
    this.snapshot = join(this.directory, 'repo'); this.config = join(this.directory, 'cli.toml');
    process.on('SIGINT', this.interrupt); process.on('SIGTERM', this.interrupt);
  }
  static async create(mode: 'trading' | 'development'): Promise<DashboardTestEnv> {
    const environment = new DashboardTestEnv(mode);
    try { await environment.setup(); return environment; } catch (error) { await environment.dispose(); throw error; }
  }
  private launch(command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
    if (this.stopped) throw new Error('Browser check interrupted');
    const child = spawn(command, args, { cwd: this.snapshot, env: { ...this.env, ...extraEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.add(child); this.logs.set(child, '');
    child.on('error', error => this.logs.set(child, String(error)));
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', bytes => this.logs.set(child, (this.logs.get(child)! + String(bytes)).slice(-8000)));
    return child;
  }
  private async stop(child: ChildProcess): Promise<void> {
    if (!child.pid) return;
    const finished = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(done => child.once('close', () => done()));
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
    const force = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already stopped. */ } }, 2000);
    await finished; clearTimeout(force);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* No grandchildren. */ }
    this.children.delete(child);
  }
  private run(command: string, args: string[], label: string): string {
    if (this.stopped) throw new Error('Browser check interrupted');
    try { return execFileSync(command, args, { cwd: this.snapshot, env: this.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }); }
    catch (error) { throw new Error(label === 'publisher login' ? `${label} failed` : `${label} failed: ${String((error as { stderr?: Buffer }).stderr ?? error)}`); }
  }
  cliRun(args: string[], label: string): string { return this.run(this.cli, ['--config-path', this.config, ...args], label); }
  call(reducer: string, ...args: unknown[]): string {
    return this.cliRun(['call', '--server', this.origin, this.database, reducer, ...args.map(value => JSON.stringify(value))], reducer);
  }
  rows(table: string): Record<string, any>[] {
    const output = this.cliRun(['subscribe', '--server', this.origin, this.database, `SELECT * FROM ${table}`, '--print-initial-update', '-n', '0', '--yes'], `read ${table}`);
    return JSON.parse(output.split('\n').find(line => line.startsWith('{'))!)[table]?.inserts ?? [];
  }
  role(name: string): void { this.call('grant_agent', this.publisher.identity, name); }
  private async setup(): Promise<void> {
    const module = this.mode === 'trading' ? 'spacetimedb' : 'coord';
    const filter = (path: string) => !/(?:^|\/)(node_modules|build|dist)(?:\/|$)/.test(path);
    cpSync(join(this.root, module), join(this.snapshot, module), { recursive: true, filter });
    cpSync(join(this.root, 'message-board'), join(this.snapshot, 'message-board'), { recursive: true, filter });
    cpSync(join(this.root, 'dashboard'), join(this.snapshot, 'dashboard'), { recursive: true, filter });
    cpSync(join(this.root, 'tsconfig.json'), join(this.snapshot, 'tsconfig.json'));
    cpSync(join(this.root, 'package.json'), join(this.snapshot, 'package.json'));
    symlinkSync(join(this.root, 'node_modules'), join(this.snapshot, 'node_modules'), 'dir');
    if (!/spacetimedb tool version 2\.10\.2;/.test(this.cliRun(['--version'], 'CLI version'))) throw new Error('This check requires SpacetimeDB CLI 2.10.2.');
    this.dbPort = await port(); this.dashboardPort = await port(); this.browserPort = await port();
    this.origin = `http://127.0.0.1:${this.dbPort}`; this.url = `http://127.0.0.1:${this.dashboardPort}`;
    const kind = this.mode === 'trading' ? 'dashboard' : 'development';
    this.tokenKey = `quant-swarm:${kind}:token:ws://127.0.0.1:${this.dbPort}:${this.database}`;
    const privateKey = join(this.directory, 'id_ecdsa'); const publicKey = join(this.directory, 'id_ecdsa.pub');
    this.run('openssl', ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-out', privateKey], 'temporary JWT key');
    chmodSync(privateKey, 0o600);
    this.run('openssl', ['ec', '-in', privateKey, '-pubout', '-out', publicKey], 'temporary public key');
    await this.startDatabase();
    const response = await fetch(`${this.origin}/v1/identity`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok); this.publisher = await response.json() as { token: string; identity: string };
    this.cliRun(['login', '--token', this.publisher.token], 'publisher login');
    console.log(`[dashboard:${this.mode}] Build and publish isolated fixture module`);
    this.cliRun(['publish', '--module-path', module, '--server', this.origin, '--no-config', '--yes', this.database], 'publish isolated module');
    this.cliRun(['generate', '--lang', 'typescript', '--module-path', module, '--out-dir', this.mode === 'trading' ? 'src/module_bindings' : 'dashboard/coord_bindings', '--no-config', '--yes'], 'fixture bindings');
  }
  async startDatabase(): Promise<void> {
    this.server = this.launch(this.cli, ['--config-path', this.config, 'start', '--listen-addr', `127.0.0.1:${this.dbPort}`, '--data-dir', join(this.directory, 'data'),
      '--jwt-priv-key-path', join(this.directory, 'id_ecdsa'), '--jwt-pub-key-path', join(this.directory, 'id_ecdsa.pub'), '--non-interactive']);
    await waitFor(async () => {
      if (this.server!.exitCode !== null) throw new Error(`Temporary server exited: ${this.logs.get(this.server!)}`);
      try { return (await fetch(`${this.origin}/v1/ping`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, 'isolated database start', 30_000);
  }
  async stopDatabase(): Promise<void> { assert.ok(this.server); await this.stop(this.server); }
  async openPage(): Promise<BrowserPage> {
    if (!this.webStarted) {
      const web = this.launch(process.execPath, ['dashboard/server.mjs', ...(this.mode === 'development' ? ['--development'] : [])],
        { SPACETIMEDB_HOST: `ws://127.0.0.1:${this.dbPort}`, SPACETIMEDB_DB_NAME: this.database, DASHBOARD_PORT: String(this.dashboardPort) });
      await waitFor(async () => {
        if (web.exitCode !== null) throw new Error(`Dashboard exited: ${this.logs.get(web)}`);
        try { return (await fetch(this.url, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
      }, 'isolated dashboard start');
      this.browser = this.launch(this.chrome, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${join(this.directory, 'browser-profile')}`, `--remote-debugging-port=${this.browserPort}`, '--remote-debugging-address=127.0.0.1', 'about:blank']);
      this.webStarted = true;
    }
    let target: { webSocketDebuggerUrl: string } | undefined;
    const id = this.pages.length ? (await this.pages[0].send('Target.createTarget', { url: 'about:blank' })).targetId : undefined;
    await waitFor(async () => {
      if (this.browser!.exitCode !== null) throw new Error(`Chrome exited: ${this.logs.get(this.browser!)}`);
      try {
        const tabs = await (await fetch(`http://127.0.0.1:${this.browserPort}/json/list`)).json() as Array<{ id: string; type: string; webSocketDebuggerUrl: string }>;
        target = tabs.find(tab => tab.type === 'page' && (!id || tab.id === id));
      } catch { /* Starting. */ }
      return target;
    }, 'Chrome debugger');
    const page = await BrowserPage.connect(target!.webSocketDebuggerUrl); this.pages.push(page);
    await page.send('Page.navigate', { url: this.url });
    return page;
  }
  async dispose(): Promise<void> {
    for (const page of this.pages) page.close();
    await Promise.all([...this.children].map(child => this.stop(child)));
    process.off('SIGINT', this.interrupt); process.off('SIGTERM', this.interrupt);
    rmSync(this.directory, { recursive: true, force: true });
  }
}
