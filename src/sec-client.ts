import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TICKERS = 'https://www.sec.gov/files/company_tickers.json';
const ARCHIVES = 'https://www.sec.gov/Archives/edgar/data/';
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export interface SecClientOptions {
  userAgent: string;
  cacheDir: string;
  rateDir?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (event: { kind: 'hit' | 'download' | 'revalidated' | 'retry' | 'invalid-cache'; url: string; attempt?: number; delayMs?: number }) => void;
}

interface CacheEntry {
  version: 1;
  url: string;
  accept: string;
  fetchedAt: number;
  verifiedAt: number;
  etag?: string;
  lastModified?: string;
  checksum: string;
  bytes: number;
  body: string;
}

interface RateDatabase {
  exec(sql: string): void;
  prepare(sql: string): { get(): { version: number; gap_ms: number } | undefined; run(): unknown };
  close(): void;
}
class SecRateGateError extends Error {}

export function requireSecUrl(url: string): void {
  const parsed = new URL(url);
  const permitted = url === TICKERS ||
    (parsed.origin === 'https://data.sec.gov' && /^\/(submissions|api\/xbrl\/companyfacts)\/CIK\d{10}\.json$/.test(parsed.pathname)) ||
    (parsed.origin === 'https://www.sec.gov' && /^\/Archives\/edgar\/data\/\d+\/\d{18}\/[A-Za-z0-9._-]+$/.test(parsed.pathname));
  if (!permitted || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`SEC route is not allow-listed: ${url}`);
}

function validateBody(body: Buffer, accept: string): void {
  if (body.length === 0) throw new Error('SEC returned an empty body');
  if (accept === 'application/json') {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('SEC JSON must be an object');
  }
}

function retryDelay(value: string | null, attempt: number, now: number): number {
  const backoff = 500 * 2 ** (attempt - 1);
  if (value === null) return backoff;
  const seconds = /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : undefined;
  const requested = seconds === undefined ? Date.parse(value) - now : seconds * 1000;
  if (!Number.isFinite(requested)) return backoff;
  // Do not shorten a server's requested delay: fail this ingest if it exceeds the bounded budget.
  if (requested > 30_000) throw new Error('SEC Retry-After exceeds 30-second retry budget; retry the ingest later');
  return Math.max(backoff, requested);
}

/** One serialized, rate-limited SEC download queue per ingestor process. */
export class SecClient {
  private readonly options: SecClientOptions;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rateDir: string;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, Promise<Buffer>>();

  constructor(options: SecClientOptions) {
    if (!/\S+@\S+\.\S+/.test(options.userAgent) || /[\r\n]/.test(options.userAgent)) throw new Error('SEC_USER_AGENT must include a contact email');
    this.options = options;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
    this.rateDir = options.rateDir ?? process.env.SEC_RATE_DIR ?? join(homedir(), '.local/share/quant-swarm/rate/sec');
  }

  get(url: string, accept = 'application/json'): Promise<Buffer> {
    requireSecUrl(url);
    const key = sha256(`${url}\n${accept}`);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const result = this.tail.then(() => this.load(url, accept, key));
    this.tail = result.then(() => undefined, () => undefined);
    this.pending.set(key, result);
    void result.then(() => this.pending.delete(key), () => this.pending.delete(key));
    return result;
  }

  private async cached(file: string, url: string, accept: string): Promise<{ entry: CacheEntry; body: Buffer } | undefined> {
    try {
      const entry = JSON.parse(await readFile(file, 'utf8')) as CacheEntry;
      if (entry.version !== 1 || entry.url !== url || entry.accept !== accept || typeof entry.body !== 'string' ||
          !Number.isFinite(entry.verifiedAt) || !Number.isFinite(entry.fetchedAt) || entry.fetchedAt < 0 ||
          entry.verifiedAt < entry.fetchedAt || entry.verifiedAt > this.now() ||
          (entry.etag !== undefined && (typeof entry.etag !== 'string' || /[\r\n]/.test(entry.etag))) ||
          (entry.lastModified !== undefined && (typeof entry.lastModified !== 'string' || /[\r\n]/.test(entry.lastModified)))) throw new Error('Invalid cache metadata');
      const body = Buffer.from(entry.body, 'base64');
      if (body.length !== entry.bytes || sha256(body) !== entry.checksum) throw new Error('Cache checksum mismatch');
      validateBody(body, accept);
      return { entry, body };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof SyntaxError || (error instanceof Error && !(error as NodeJS.ErrnoException).code)) {
        this.options.onEvent?.({ kind: 'invalid-cache', url });
        return undefined;
      }
      throw error;
    }
  }

  private async save(file: string, entry: CacheEntry): Promise<void> {
    await mkdir(this.options.cacheDir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(entry), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }

  private async withRateGate<T>(request: () => Promise<T>): Promise<T> {
    let database: RateDatabase | undefined;
    try {
      if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('SEC shared rate gate requires Node.js 24+');
      await mkdir(this.rateDir, { recursive: true, mode: 0o700 });
      // Use the built-in API lazily; the repo's older Node typings lack this module.
      // SQLite supplies OS-released process locks; this is transport metadata, not swarm state.
      const moduleName: string = 'node:sqlite';
      const sqlite = await import(moduleName) as { DatabaseSync: new (path: string) => RateDatabase };
      const file = join(this.rateDir, 'gate.sqlite');
      database = new sqlite.DatabaseSync(file);
      await chmod(file, 0o600);
      database.exec('PRAGMA busy_timeout=0');
      const deadline = Date.now() + 35_000;
      for (;;) {
        try { database.exec('BEGIN IMMEDIATE'); break; }
        catch (error) {
          const code = Number((error as { errcode?: number }).errcode) & 255;
          if (![5, 6].includes(code) || Date.now() >= deadline) throw error;
          await new Promise(done => setTimeout(done, 50));
        }
      }
      database.exec('CREATE TABLE IF NOT EXISTS gate_policy (version INTEGER PRIMARY KEY, gap_ms INTEGER NOT NULL) STRICT');
      database.exec('INSERT OR IGNORE INTO gate_policy VALUES (1,200)');
      const policy = database.prepare('SELECT version,gap_ms FROM gate_policy').get();
      if (policy?.version !== 1 || policy.gap_ms !== 200) throw new Error('Unsupported SEC rate gate policy');
      // Always wait after acquisition. Even a killed previous owner cannot release a
      // just-started request into an immediate next request. Hold through body completion.
      await this.sleep(200);
    } catch (error) {
      database?.close();
      throw new SecRateGateError(`SEC shared rate gate unavailable: ${String(error)}`);
    }
    try { return await request(); }
    finally {
      try { database.exec('COMMIT'); }
      catch (error) { throw new SecRateGateError(`SEC shared rate gate commit failed: ${String(error)}`); }
      finally { database.close(); }
    }
  }

  private async load(url: string, accept: string, key: string): Promise<Buffer> {
    const file = join(this.options.cacheDir, `${key}.json`);
    const cached = await this.cached(file, url, accept);
    const ttl = url.startsWith(ARCHIVES) ? 86_400_000 : 300_000;
    if (cached && this.now() - cached.entry.verifiedAt < ttl) {
      this.options.onEvent?.({ kind: 'hit', url });
      return cached.body;
    }
    const headers: Record<string, string> = { 'user-agent': this.options.userAgent, accept };
    if (cached?.entry.etag) headers['if-none-match'] = cached.entry.etag;
    if (cached?.entry.lastModified) headers['if-modified-since'] = cached.entry.lastModified;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let response: Response | undefined;
      let body: Buffer | undefined;
      let failure: unknown;
      try {
        const downloaded = await this.withRateGate(async () => {
          const response = await this.fetcher(url, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(30_000) });
          const body = response.ok ? Buffer.from(await response.arrayBuffer()) : undefined;
          if (!response.ok) await response.body?.cancel();
          return { response, body };
        });
        response = downloaded.response; body = downloaded.body;
      } catch (error) { if (error instanceof SecRateGateError) throw error; failure = error; }
      if (failure || (response && RETRY_STATUSES.has(response.status))) {
        if (attempt === 3) throw new Error(`SEC GET ${url} failed after 3 attempts (${failure ? String(failure) : response?.status})`);
        const delayMs = retryDelay(response?.headers.get('retry-after') ?? null, attempt, this.now());
        this.options.onEvent?.({ kind: 'retry', url, attempt, delayMs });
        await this.sleep(delayMs);
        continue;
      }
      if (response?.status === 304 && cached) {
        await this.save(file, { ...cached.entry, verifiedAt: this.now(),
          etag: response.headers.get('etag') ?? cached.entry.etag,
          lastModified: response.headers.get('last-modified') ?? cached.entry.lastModified });
        this.options.onEvent?.({ kind: 'revalidated', url });
        return cached.body;
      }
      if (!response?.ok || !body) throw new Error(`SEC GET ${url} failed (${response?.status ?? 'no response'})`);
      validateBody(body, accept);
      const now = this.now();
      await this.save(file, { version: 1, url, accept, fetchedAt: now, verifiedAt: now,
        etag: response.headers.get('etag') ?? undefined, lastModified: response.headers.get('last-modified') ?? undefined,
        bytes: body.length, checksum: sha256(body), body: body.toString('base64') });
      this.options.onEvent?.({ kind: 'download', url });
      return body;
    }
    throw new Error('SEC retries exhausted');
  }
}
