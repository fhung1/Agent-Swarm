import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPayload, OperationJournal, type RecoveryContext } from './operation-journal.ts';

const scope = { runId: 'run', worldId: 'world', historyId: 'history', actorId: 'actor' };
const context: RecoveryContext = { scope, tick: 10, boardConnected: true, taskId: 'task', ownsTask: true, reservationValid: true };
function fixture(fn: (journal: OperationJournal, path: string) => void): void {
  const path = mkdtempSync(join(tmpdir(), 'factorio-journal-'));
  try { fn(new OperationJournal(path, scope), path); } finally { rmSync(path, { recursive: true, force: true }); }
}
function receipt(digest: string) {
  return { version: 1, scope, operationId: 'op', digest, tick: 11, status: 'succeeded', result: '{"plates":5}' };
}

test('crash after game execution recovers receipt without admitting another resource mutation', () => fixture((journal, path) => {
  const first = journal.prepare('op', { kind: 'insert', count: 5 }, context);
  assert.equal(first.created, true);
  let resourceChanges = first.created ? 1 : 0;
  const restarted = new OperationJournal(path, scope);
  const retry = restarted.prepare('op', { count: 5, kind: 'insert' }, { ...context, tick: 12 });
  if (retry.created) resourceChanges++;
  assert.equal(resourceChanges, 1);
  assert.equal(restarted.reconcile('op', receipt(first.intent.digest), { ...context, tick: 12 }).status, 'complete');
  assert.equal(restarted.reconcile('op', receipt(first.intent.digest), { ...context, tick: 12 }).status, 'complete');
  assert.equal(restarted.prepare('next', { kind: 'observe' }, { ...context, tick: 12 }).created, true);
}));

test('missing outcome blocks both replay and subsequent operations after restart', () => fixture((journal, path) => {
  journal.prepare('op', { count: 5 }, context);
  const restarted = new OperationJournal(path, scope);
  assert.throws(() => restarted.reconcile('op', null, context), /Unknown game outcome/);
  assert.equal(restarted.prepare('op', { count: 5 }, context).created, false);
  assert.throws(() => restarted.prepare('other', {}, context), /unresolved/);
}));

test('pending receipts never release the avatar and failed terminal receipts do', () => fixture(journal => {
  const { intent } = journal.prepare('op', {}, context);
  const r = receipt(intent.digest);
  assert.equal(journal.reconcile('op', { ...r, status: 'pending' }, { ...context, tick: 12 }).status, 'pending');
  assert.throws(() => journal.prepare('other', {}, { ...context, tick: 12 }), /unresolved/);
  journal.reconcile('op', { ...r, status: 'failed' }, { ...context, tick: 12 });
  assert.equal(journal.prepare('other', {}, { ...context, tick: 12 }).created, true);
}));

test('world history, rollback, ownership and connectivity fail closed', () => fixture((journal, path) => {
  const { intent } = journal.prepare('op', {}, context);
  assert.throws(() => new OperationJournal(path, { ...scope, historyId: 'new' }), /conflict/);
  for (const changed of [
    { scope: { ...scope, worldId: 'other' } }, { tick: 9 }, { boardConnected: false },
    { ownsTask: false }, { reservationValid: false }, { taskId: 'other' },
  ]) assert.throws(() => journal.reconcile('op', receipt(intent.digest), { ...context, tick: 12, ...changed } as RecoveryContext));
  journal.reconcile('op', receipt(intent.digest), { ...context, tick: 12 });
  assert.throws(() => new OperationJournal(path, scope).prepare('next', {}, context), /rollback/);
}));

test('changed commands, receipts and forged identity are rejected', () => fixture(journal => {
  const { intent } = journal.prepare('op', { count: 5 }, context);
  assert.throws(() => journal.prepare('op', { count: 6 }, context), /different content/);
  const r = receipt(intent.digest);
  for (const changed of [{ digest: '0'.repeat(64) }, { operationId: 'other' }, { scope: { ...scope, actorId: 'other' } }, { tick: 9 }, { tick: 13 }]) {
    assert.throws(() => journal.reconcile('op', { ...r, ...changed }, { ...context, tick: 12 }));
  }
  journal.reconcile('op', r, { ...context, tick: 12 });
  assert.throws(() => journal.reconcile('op', { ...r, result: '{}' }, { ...context, tick: 12 }), /changed/);
  assert.throws(() => journal.reconcile('op', null, { ...context, tick: 12 }), /Unknown/);
}));

test('disk records remain private, corruption fails, and interrupted temporary files are ignored', () => fixture((journal, path) => {
  journal.prepare('../op', { count: 5 }, context);
  writeFileSync(join(path, '.pending-interrupted'), '{');
  assert.equal(new OperationJournal(path, scope).intents().length, 1);
  const name = readdirSync(path).find(name => name.endsWith('.intent.json'))!;
  assert.equal(statSync(join(path, name)).mode & 0o777, 0o600);
  const value = JSON.parse(readFileSync(join(path, name), 'utf8'));
  value.payload = '{}';
  writeFileSync(join(path, name), JSON.stringify(value));
  assert.throws(() => new OperationJournal(path, scope).prepare('new', {}, context), /Corrupt/);
}));

test('canonical payloads are stable and reject non-JSON or oversized input', () => {
  assert.equal(canonicalPayload({ b: [true, null], a: 1 }), canonicalPayload({ a: 1, b: [true, null] }));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const invalid of [undefined, NaN, Infinity, 1n, new Date(), cyclic, { a: undefined }, new Array(2), 'x'.repeat(65_537)]) {
    assert.throws(() => canonicalPayload(invalid));
  }
});


test('two processes cannot admit competing operations for the same avatar', async () => {
  const path = mkdtempSync(join(tmpdir(), 'factorio-journal-race-'));
  try {
    new OperationJournal(path, scope);
    const moduleUrl = new URL('./operation-journal.ts', import.meta.url).href;
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => {
      const code = `import {OperationJournal} from ${JSON.stringify(moduleUrl)};
        try {
          const j = new OperationJournal(${JSON.stringify(path)}, ${JSON.stringify(scope)});
          console.log(j.prepare('race-${index}', {count:5}, ${JSON.stringify(context)}).created ? 'admitted' : 'existing');
        } catch { console.log('blocked'); }`;
      return promisify(execFile)(process.execPath, ['--input-type=module', '-e', code]);
    }));
    assert.equal(results.filter(result => result.stdout.trim() === 'admitted').length, 1);
    assert.equal(new OperationJournal(path, scope).intents().length, 1);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test('latest observed tick survives restart even while an operation is pending', () => fixture((journal, path) => {
  const { intent } = journal.prepare('op', {}, context);
  journal.reconcile('op', { ...receipt(intent.digest), status: 'pending' }, { ...context, tick: 100 });
  assert.throws(() => new OperationJournal(path, scope).reconcile('op', receipt(intent.digest), { ...context, tick: 99 }), /rollback/);
}));
