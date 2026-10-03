#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `Prepare an isolated graphical Factorio client to watch the gameplay agents.

node factorio-acceptance/viewer.mjs --binary /path/to/graphical/factorio \\
  --mod /path/to/server/bridge-mod --address 127.0.0.1:34197 [--launch]

Options:
  --binary PATH       Graphical Factorio executable (or FACTORIO_CLIENT_BIN)
  --mod PATH          Exact bridge mod directory installed on the server
  --address HOST:PORT Server game address, default 127.0.0.1:34197 (UDP, not RCON)
  --version VERSION   Required server version, default 2.0.77
  --state-dir PATH    Dedicated client mod directory parent; default .game-runs/factorio-viewer
  --launch            Start the GUI client and connect after validation

Uses a separate mod directory; does not change your normal mods or saves.
A purchased graphical Factorio client is required; the headless download cannot display agents.`;

export function parseArguments(args, env = process.env) {
  const options = { binary: env.FACTORIO_CLIENT_BIN, mod: '', address: '127.0.0.1:34197', version: '2.0.77', stateDir: '.game-runs/factorio-viewer', launch: false };
  const names = { '--binary': 'binary', '--mod': 'mod', '--address': 'address', '--version': 'version', '--state-dir': 'stateDir' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return { help: true };
    if (arg === '--launch') { options.launch = true; continue; }
    if (!Object.hasOwn(names, arg)) throw new Error(`Unknown option: ${arg}`);
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[names[arg]] = args[++i];
  }
  if (!options.binary || !options.mod) throw new Error('--binary and --mod are required. Use --help for examples.');
  // Accept DNS, IPv4 or bracketed IPv6 without treating addresses as command switches.
  const match = /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*|\[[a-fA-F0-9:]+\]):([0-9]+)$/.exec(options.address);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error('Address must be HOST:PORT with port 1–65535.');
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) throw new Error('Version must be an exact Factorio version, e.g. 2.0.77.');
  return options;
}

export function validateBinaryOutput(output, requiredVersion) {
  if (/headless/i.test(output)) throw new Error('This is a headless server binary. Supply a graphical Factorio client to view the agents.');
  const version = /^Version:\s+(\d+\.\d+\.\d+)\b/m.exec(output)?.[1];
  if (version !== requiredVersion) throw new Error(`Graphical client version ${version ?? 'unknown'} does not match server version ${requiredVersion}.`);
  return version;
}

function directoryHash(directory) {
  const hash = createHash('sha256');
  function visit(path, relative = '') {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const file = relative + name;
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) throw new Error(`Mod contains a symbolic link: ${file}`);
      if (stat.isDirectory()) visit(child, file + '/');
      else if (stat.isFile()) hash.update(file + '\0').update(readFileSync(child)).update('\0');
      else throw new Error(`Unsupported mod entry: ${file}`);
    }
  }
  visit(directory);
  return hash.digest('hex');
}

export function prepareViewer(options) {
  const source = resolve(options.mod);
  const metadata = JSON.parse(readFileSync(join(source, 'info.json'), 'utf8'));
  if (!/^[a-zA-Z0-9_-]+$/.test(metadata.name) || !/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error('Invalid mod name/version in info.json.');
  if (metadata.factorio_version !== options.version.split('.').slice(0, 2).join('.')) throw new Error('Bridge mod targets a different Factorio major/minor version.');
  const hash = directoryHash(source);
  const state = resolve(options.stateDir);
  const mods = join(state, 'mods');
  const manifestPath = join(state, 'viewer.json');
  const manifest = { version: options.version, mod: metadata.name, modVersion: metadata.version, sha256: hash };
  if (existsSync(state)) {
    if (!existsSync(manifestPath)) throw new Error('Viewer state directory already exists and is not owned by this helper. Choose a new --state-dir.');
    const previous = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (JSON.stringify(previous) !== JSON.stringify(manifest)) throw new Error('Viewer mod/version changed. Choose a new --state-dir to preserve the old installation.');
  } else {
    mkdirSync(state, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  mkdirSync(mods, { recursive: true });
  const target = join(mods, `${metadata.name}_${metadata.version}`);
  if (existsSync(target)) {
    if (directoryHash(target) !== hash) throw new Error('Installed viewer mod differs from the server mod. Choose a new --state-dir.');
  } else cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
  const modList = { mods: [{ name: 'base', enabled: true }, { name: metadata.name, enabled: true }, ...['space-age', 'quality', 'elevated-rails'].map(name => ({ name, enabled: false }))] };
  writeFileSync(join(mods, 'mod-list.json'), JSON.stringify(modList, null, 2) + '\n');
  return { mods, manifest, args: ['--mod-directory', mods, '--mp-connect', options.address] };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) { console.log(HELP); return; }
  const result = spawnSync(options.binary, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error(`Cannot inspect Factorio client: ${result.error?.message ?? `exit ${result.status}`}`);
  validateBinaryOutput(result.stdout + result.stderr, options.version);
  const prepared = prepareViewer(options);
  console.log(`Prepared ${prepared.manifest.mod} ${prepared.manifest.modVersion} for Factorio ${options.version}.`);
  console.log(`Connect to ${options.address}; client mods: ${prepared.mods}`);
  console.log(`Server mod SHA-256: ${prepared.manifest.sha256}`);
  if (!options.launch) { console.log('Add --launch to open Factorio and connect.'); return; }
  const child = spawn(options.binary, prepared.args, { stdio: 'inherit' });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0))); });
  if (code !== 0) throw new Error(`Graphical Factorio exited with status ${code}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
