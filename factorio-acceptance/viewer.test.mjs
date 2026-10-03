import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArguments, prepareViewer, validateBinaryOutput } from './viewer.mjs';

test('rejects headless and mismatched clients before graphical launch', () => {
  assert.throws(() => validateBinaryOutput('Version: 2.0.77 (build 84539, linux64, headless)', '2.0.77'), /headless server/);
  assert.throws(() => validateBinaryOutput('Version: 2.0.76 (linux64, full)', '2.0.77'), /does not match/);
  assert.equal(validateBinaryOutput('Version: 2.0.77 (build 84539, linux64, full)', '2.0.77'), '2.0.77');
});

test('parses addresses without command injection or missing-value ambiguity', () => {
  const base = ['--binary', '/a path/factorio', '--mod', '/a mod'];
  assert.equal(parseArguments([...base, '--address', '[::1]:34197'], {}).address, '[::1]:34197');
  assert.equal(parseArguments(base, {}).launch, false);
  for (const bad of ['--bad', 'localhost:70000', 'a;cmd:34197', 'localhost:0']) {
    assert.throws(() => parseArguments([...base, '--address', bad], {}));
  }
});

test('prepares only isolated mods, reuses exact content, refuses changed or unowned state', () => {
  const root = mkdtempSync(join(tmpdir(), 'factorio-viewer-test-'));
  try {
    const source = join(root, 'source'); mkdirSync(source);
    writeFileSync(join(source, 'info.json'), JSON.stringify({ name: 'swarm-bridge', version: '0.1.0', factorio_version: '2.0' }));
    writeFileSync(join(source, 'control.lua'), 'return {}');
    const options = { mod: source, stateDir: join(root, 'viewer'), version: '2.0.77', address: '127.0.0.1:34197' };
    const first = prepareViewer(options);
    assert.deepEqual(prepareViewer(options), first);
    assert.deepEqual(JSON.parse(readFileSync(join(first.mods, 'mod-list.json'))).mods, [{ name: 'base', enabled: true }, { name: 'swarm-bridge', enabled: true }]);
    assert.equal(first.args.at(-1), '127.0.0.1:34197');
    const unowned = join(root, 'existing'); mkdirSync(unowned);
    writeFileSync(join(unowned, 'keep.txt'), 'keep');
    assert.throws(() => prepareViewer({ ...options, stateDir: unowned }), /not owned/);
    assert.equal(readFileSync(join(unowned, 'keep.txt'), 'utf8'), 'keep');
    writeFileSync(join(source, 'control.lua'), 'changed');
    assert.throws(() => prepareViewer(options), /changed/);
    symlinkSync(join(source, 'control.lua'), join(source, 'link'));
    assert.throws(() => prepareViewer({ ...options, stateDir: join(root, 'other') }), /symbolic link/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
