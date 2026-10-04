/**
 * Provider-free gate for the Factorio inference path.
 *
 * The two suites inject an Ask implementation and an in-memory board/game
 * boundary, so this runner makes no network, Factorio, SpacetimeDB, or model
 * calls. Keep this as a standalone command for CI and pre-live operator use.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const suites = [
  'src/factorio/inference.test.ts',
  'src/factorio/inference-launch.test.ts',
  'src/factorio/orchestrator.test.ts',
  'src/factorio/inference-worker.test.ts',
];

const output = mkdtempSync(join(tmpdir(), 'factorio-inference-tests-'));
const esbuild = process.platform === 'win32' ? 'node_modules/.bin/esbuild.cmd' : 'node_modules/.bin/esbuild';
for (const suite of suites) {
  const bundled = join(output, suite.replaceAll('/', '-').replace(/\.ts$/, '.mjs'));
  execFileSync(esbuild, [suite, '--bundle', '--platform=node', '--format=esm', `--outfile=${bundled}`], { stdio: 'inherit' });
  execFileSync(process.execPath, [bundled], { stdio: 'inherit' });
}
console.log('PASS Factorio inference contract and worker boundary (provider-free)');
