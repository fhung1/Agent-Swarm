import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[\x20-\x7e]+$/);
const tick = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scopeSchema = z.object({ runId: id, worldId: id, historyId: id, actorId: id }).strict();
const pendingSchema = z.object({
  version: z.literal(1), scope: scopeSchema, operationId: id, taskId: id,
  observedTick: tick, payload: z.string().max(65_536), digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const receiptSchema = z.object({
  version: z.literal(1), scope: scopeSchema, operationId: id,
  digest: z.string().regex(/^[a-f0-9]{64}$/), tick,
  status: z.enum(['pending', 'succeeded', 'failed']), result: z.string().max(65_536),
}).strict();
const contextSchema = z.object({
  scope: scopeSchema, tick, boardConnected: z.literal(true),
  taskId: id, ownsTask: z.literal(true), reservationValid: z.literal(true),
}).strict();
export type JournalScope = z.infer<typeof scopeSchema>;
export type OperationIntent = z.infer<typeof pendingSchema>;
export type OperationReceipt = z.infer<typeof receiptSchema>;
export type RecoveryContext = z.infer<typeof contextSchema>;

// The bridge must calculate this same canonical representation before attesting a receipt.
export function canonicalPayload(value: unknown): string {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): string {
    if (depth > 32) throw new Error('Payload nesting exceeds 32');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== 'object' || v === null || seen.has(v)) throw new Error('Payload must be finite acyclic JSON');
    seen.add(v);
    let result: string;
    if (Array.isArray(v)) {
      result = '[' + Array.from(v, item => visit(item, depth + 1)).join(',') + ']';
    } else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('Payload must contain plain objects');
      if (Reflect.ownKeys(v).length !== Object.keys(v).length) throw new Error('Payload contains unsupported properties');
      result = '{' + Object.keys(v).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        if (!('value' in descriptor)) throw new Error('Payload accessors are forbidden');
        return JSON.stringify(key) + ':' + visit(descriptor.value, depth + 1);
      }).join(',') + '}';
    }
    seen.delete(v);
    if (Buffer.byteLength(result) > 65_536) throw new Error('Payload exceeds 64 KiB');
    return result;
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(result) > 65_536) throw new Error('Payload exceeds 64 KiB');
  return result;
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const equal = (a: unknown, b: unknown): boolean => canonicalPayload(a) === canonicalPayload(b);

/** Private, single-avatar journal. Records are immutable and atomically published.
 * This records evidence; callers still enforce board ownership and game-side validation.
 */
export class OperationJournal {
  readonly directory: string;
  readonly scope: JournalScope;

  constructor(directory: string, scope: JournalScope) {
    this.directory = resolve(directory);
    this.scope = Object.freeze(scopeSchema.parse(scope));
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Journal directory must be private (0700)');
    this.publish('scope.json', this.scope);
  }

  private read(name: string): unknown | undefined {
    let fd: number;
    try { fd = openSync(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    try {
      const text = readFileSync(fd, 'utf8');
      if (Buffer.byteLength(text) > 262_144) throw new Error('Oversized journal record');
      return JSON.parse(text);
    } finally { closeSync(fd); }
  }

  private publish(name: string, value: unknown): boolean {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 262_144) throw new Error('Oversized journal record');
    const temporary = join(this.directory, `.pending-${randomUUID()}`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    let created = false;
    try {
      try { linkSync(temporary, join(this.directory, name)); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (!created && JSON.stringify(this.read(name)) !== text) throw new Error(`Journal record conflict: ${name}`);
      const directoryFd = openSync(this.directory, 'r');
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      return created;
    } finally { unlinkSync(temporary); }
  }

  private filename(operationId: string, suffix: string): string {
    return `${hash(id.parse(operationId))}.${suffix}.json`;
  }

  intents(): OperationIntent[] {
    return readdirSync(this.directory).filter(name => name.endsWith('.intent.json')).sort().map((name, index) => {
      const intent = pendingSchema.parse(this.read(name));
      if (!equal(intent.scope, this.scope) || hash(intent.payload) !== intent.digest || name !== `${String(index).padStart(12, '0')}.intent.json`) throw new Error('Corrupt or foreign intent');
      if (canonicalPayload(JSON.parse(intent.payload)) !== intent.payload) throw new Error('Noncanonical intent');
      return intent;
    });
  }

  private savedReceipt(intent: OperationIntent): OperationReceipt | undefined {
    const raw = this.read(this.filename(intent.operationId, 'receipt'));
    if (raw === undefined) return undefined;
    const receipt = receiptSchema.parse(raw);
    if (!equal(receipt.scope, intent.scope) || receipt.operationId !== intent.operationId ||
        receipt.digest !== intent.digest || receipt.tick < intent.observedTick || receipt.status === 'pending') {
      throw new Error('Corrupt completed receipt');
    }
    return receipt;
  }

  private validateContext(context: RecoveryContext): RecoveryContext {
    const parsed = contextSchema.parse(context);
    if (!equal(parsed.scope, this.scope)) throw new Error('World/run/history/avatar mismatch');
    // Every persisted observation and receipt sets a floor, including after restart.
    const checkpoints = readdirSync(this.directory).filter(name => name.endsWith('.tick.json')).map(name => {
      const value = z.object({ scope: scopeSchema, tick }).strict().parse(this.read(name));
      if (!equal(value.scope, this.scope) || name !== `${String(value.tick).padStart(16, '0')}.tick.json`) throw new Error('Corrupt tick checkpoint');
      return value.tick;
    });
    const floor = this.intents().reduce((max, intent) => {
      const receipt = this.savedReceipt(intent);
      return Math.max(max, intent.observedTick, receipt?.tick ?? 0);
    }, checkpoints.reduce((max, value) => Math.max(max, value), 0));
    if (parsed.tick < floor) throw new Error('World tick rollback detected');
    this.publish(`${String(parsed.tick).padStart(16, '0')}.tick.json`, { scope: this.scope, tick: parsed.tick });
    return parsed;
  }

  /** Only created=true can be submitted, in this uninterrupted admission attempt.
   * An existing intent must go through reconcile; missing receipts never authorize replay.
   */
  prepare(operationId: string, payload: unknown, context: RecoveryContext): { intent: OperationIntent; created: boolean } {
    const checked = this.validateContext(context);
    const canonical = canonicalPayload(payload);
    const intent = pendingSchema.parse({ version: 1, scope: this.scope, operationId, taskId: checked.taskId,
      observedTick: checked.tick, payload: canonical, digest: hash(canonical) });
    const records = this.intents();
    const previous = records.find(item => item.operationId === operationId);
    if (previous !== undefined) {
      const existing = pendingSchema.parse(previous);
      if (!equal(existing.scope, intent.scope) || existing.taskId !== intent.taskId || existing.payload !== canonical || existing.digest !== intent.digest) throw new Error('Operation ID reused with different content');
      return { intent: existing, created: false };
    }
    // Refuse a second unresolved operation for this avatar.
    if (records.some(item => this.savedReceipt(item) === undefined)) throw new Error('Reconcile unresolved operation before preparing another');
    return { intent, created: this.publish(`${String(records.length).padStart(12, '0')}.intent.json`, intent) };
  }

  reconcile(operationId: string, gameReceipt: unknown, context: RecoveryContext): { status: 'pending' | 'complete'; receipt: OperationReceipt } {
    const checked = this.validateContext(context);
    const intent = pendingSchema.parse(this.intents().find(item => item.operationId === operationId));
    if (intent.taskId !== checked.taskId) throw new Error('Task ownership mismatch');
    if (gameReceipt === null || gameReceipt === undefined) throw new Error('Unknown game outcome: stop; do not replay');
    const receipt = receiptSchema.parse(gameReceipt);
    if (!equal(receipt.scope, intent.scope) || receipt.operationId !== intent.operationId || receipt.digest !== intent.digest) throw new Error('Receipt does not match pending operation');
    if (receipt.tick < intent.observedTick || receipt.tick > checked.tick) throw new Error('Receipt tick outside observed history');
    const saved = this.read(this.filename(operationId, 'receipt'));
    if (saved !== undefined && !equal(saved, receipt)) throw new Error('Game receipt changed after completion');
    if (receipt.status === 'pending') return { status: 'pending', receipt };
    this.publish(this.filename(operationId, 'receipt'), receipt);
    return { status: 'complete', receipt };
  }
}
