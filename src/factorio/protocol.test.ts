import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeOperation, validateCommand, type Operation } from './protocol.ts';
const operation: Operation = { version: 1, worldId: 'world-1', historyId: 'history-1', operationId: 'take-1', actorId: 12,
  command: { kind: 'take', targetId: 20, item: 'iron-ore', quantity: 5 } };
test('operation digest and request are stable across property insertion order', () => {
  assert.deepEqual(encodeOperation(operation), encodeOperation({ ...operation, command: { quantity: 5, item: 'iron-ore', targetId: 20, kind: 'take' } }));
  assert.match(encodeOperation(operation).digest, /^[a-f0-9]{64}$/);
  assert.notEqual(encodeOperation(operation).digest, encodeOperation({ ...operation, command: { ...operation.command, quantity: 6 } as Operation['command'] }).digest);
});
test('commands reject executable text, unexpected fields, invalid names and unbounded arguments', () => {
  for (const command of [null, 'lua', { kind: 'lua', code: 'game.print(1)' }, { kind: 'move', x: Infinity, y: 0, maxTicks: 10 },
    { kind: 'move', x: 0, y: 0, maxTicks: 601 }, { kind: 'take', targetId: 1, item: 'iron-ore', quantity: 101 },
    { kind: 'mine', name: 'iron-ore', x: 0, y: 0, quantity: 21 },
    { kind: 'mine', name: 'iron-ore', x: 1000000.00000001, y: 0, quantity: 1 },
    { kind: 'mine', name: 'iron ore', x: 0, y: 0, quantity: 1 },
    { kind: 'mine', name: 'iron-ore', x: 0, y: 0, quantity: 1, targetId: 1 },
    { kind: 'put', targetId: 1, item: 'Rocket Silo', quantity: 1 }, { kind: 'take', targetId: -1, item: 'coal', quantity: 1 },
    { kind: 'research', technology: 'automation', instant: true }, { kind: 'research', technology: 'bad name' },
    { kind: 'set_recipe', targetId: 0, recipe: 'iron-gear-wheel' }, { kind: 'set_recipe', targetId: 1, recipe: 'game.print(1)' },
    { kind: 'move', x: 0, y: 0, maxTicks: 10, lua: 'bad' }]) assert.throws(() => validateCommand(command), { name: 'Error' }, JSON.stringify(command));
});
test('envelopes reject injected identifiers and extra fields', () => {
  assert.throws(() => encodeOperation({ ...operation, operationId: '\"; game.print(1)' }));
  assert.throws(() => encodeOperation({ ...operation, actorId: 0 }));
  assert.throws(() => encodeOperation({ ...operation, extra: true } as Operation));
});
test('Python bridge and TypeScript share normalized wire bytes and digest vectors', () => {
  const world = mkdtempSync(resolve(tmpdir(), 'factorio-wire-'));
  try {
    writeFileSync(resolve(world, 'manifest.json'), JSON.stringify({ worldId: 'world-1', historyId: 'history-1' }));
    for (const command of [
      { kind: 'move' as const, x: 0.000001, y: -0, maxTicks: 10 },
      { kind: 'move' as const, x: 1e-8, y: -1e-7, maxTicks: 10 },
      { kind: 'move' as const, x: 0.00000029, y: -0.00000057, maxTicks: 10 },
      { kind: 'move' as const, x: 999999.99999999, y: -1000000, maxTicks: 10 },
      // This is an observed Factorio position, represented exactly by the wire grid.
      { kind: 'move' as const, x: 8.6796875, y: -12.3456789, maxTicks: 600 },
      { kind: 'take' as const, targetId: 20, item: 'iron-ore' as const, quantity: 5 },
      { kind: 'research' as const, technology: 'automation' },
      { kind: 'set_recipe' as const, targetId: 20, recipe: 'iron-gear-wheel' },
      { kind: 'mine' as const, name: 'iron-ore', x: 8.6796875, y: -12.3456789, quantity: 20 },
    ]) {
      const operation: Operation = { version: 1, worldId: 'world-1', historyId: 'history-1', operationId: 'vector-1', actorId: 12, command };
      const python = execFileSync('python3', ['-c',
        "import json,pathlib,sys;sys.path.insert(0,'factorio');import bridge;print(bridge.encode(pathlib.Path(sys.argv[1]),12,'vector-1',json.loads(sys.argv[2])))",
        world, JSON.stringify(command)], { cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'), encoding: 'utf8' }).trim();
      assert.equal(python, encodeOperation(operation).request);
      assert.match(python, /"digest":"[a-f0-9]{64}"/);
    }
  } finally { rmSync(world, { recursive: true, force: true }); }
});
test('coordinates outside the exact eight-decimal wire grid are rejected by both sides', () => {
  for (const x of [0.000000001, 1.0000000000000002]) {
    assert.throws(() => validateCommand({ kind: 'move', x, y: 0, maxTicks: 10 }));
  }
  const world = mkdtempSync(resolve(tmpdir(), 'factorio-wire-'));
  try {
    writeFileSync(resolve(world, 'manifest.json'), JSON.stringify({ worldId: 'world-1', historyId: 'history-1' }));
    for (const x of [0.000000001, 1.0000000000000002]) {
      assert.throws(() => execFileSync('python3', ['-c',
        "import pathlib,sys;sys.path.insert(0,'factorio');import bridge;bridge.encode(pathlib.Path(sys.argv[1]),12,'vector-1',{'kind':'move','x':float(sys.argv[2]),'y':0,'maxTicks':10})",
        world, String(x)], { cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'), encoding: 'utf8', stdio: 'pipe' }));
    }
  } finally { rmSync(world, { recursive: true, force: true }); }
});
