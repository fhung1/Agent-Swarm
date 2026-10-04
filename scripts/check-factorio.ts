/** Provider-free Factorio contract and fault gate for CI. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const suites = readdirSync('src/factorio').filter(name => name.endsWith('.test.ts')).sort();
const output = mkdtempSync(join(tmpdir(), 'factorio-ci-'));
const esbuild = process.platform === 'win32' ? 'node_modules/.bin/esbuild.cmd' : 'node_modules/.bin/esbuild';
try {
  for (const suite of suites) {
    const bundled = join(output, suite.replace(/\.ts$/, '.mjs'));
    const source = join('src/factorio', suite);
    execFileSync(esbuild, [source, '--bundle', '--platform=node', '--format=esm',
      `--define:import.meta.url=${JSON.stringify(pathToFileURL(join(process.cwd(), source)).href)}`, `--outfile=${bundled}`], { stdio: 'inherit' });
    execFileSync(process.execPath, [bundled], { stdio: 'inherit' });
  }
  console.log(`PASS Factorio provider-free contract and fault suites (${suites.length} files)`);
} finally { rmSync(output, { recursive: true, force: true }); }
