#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import dgram from 'node:dgram';

export async function availablePort(port, protocol) {
  return new Promise(resolveResult => {
    const socket = protocol === 'udp' ? dgram.createSocket('udp4') : net.createServer();
    socket.once('error', error => resolveResult({ ok: false, detail: error.code ?? error.message }));
    const ready = () => socket.close(() => resolveResult({ ok: true }));
    if (protocol === 'udp') socket.bind(port, '127.0.0.1', ready);
    else socket.listen(port, '127.0.0.1', ready);
  });
}
export async function reachable(host, port) {
  return new Promise(resolveResult => {
    const socket = net.connect({ host, port });
    let finished = false;
    const done = ok => { if (!finished) { finished = true; socket.destroy(); resolveResult(ok); } };
    socket.setTimeout(2000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
export async function preflight({ root = process.cwd(), binary = process.env.FACTORIO_BIN ?? join(homedir(), '.local/share/agent-swarm/factorio/2.0.77/factorio/bin/x64/factorio'), configPath, checkBoard = true } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const configFile = resolve(root, configPath ?? 'config/factorio-pilot.json');
  let config;
  try { config = JSON.parse(readFileSync(configFile, 'utf8')); add('configuration', true, configFile); }
  catch (error) { add('configuration', false, `Cannot read ${configFile}: ${error.message}`); return { ok: false, checks }; }
  add('node', Number(process.versions.node.split('.')[0]) >= 22, `Node ${process.versions.node}; use Node 22 or later for tooling`);
  add('platform', process.platform === 'linux' && process.arch === 'x64', `${process.platform}/${process.arch}; headless demo host currently targets Linux x64`);
  const contract = config.version === '2.0.77' && config.agentCount === 10 && ['cooperative-starter', 'freeplay'].includes(config.scenario);
  add('pilot-contract', contract, 'Expected base 2.0.77, ten workers and an explicit cooperative-starter/freeplay scenario');
  add('board-isolation', typeof config.boardDatabase === 'string' && config.boardDatabase.length > 0 && config.boardDatabase !== 'quant-swarm-coord', 'Gameplay needs a separate database, normally quant-swarm-factorio-coord');
  try {
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).split('\n')[0];
    add('binary', version.startsWith(`Version: ${config.version} `), `${binary}: ${version}`);
  } catch (error) { add('binary', false, `Cannot run pinned Factorio binary ${binary}: ${error.code ?? 'process failed'}`); }
  try {
    const info = JSON.parse(readFileSync(resolve(root, 'factorio/mod/agent-swarm_0.1.0/info.json'), 'utf8'));
    add('bridge-mod', info.name === 'agent-swarm' && existsSync(resolve(root, 'factorio/mod/agent-swarm_0.1.0/control.lua')), `agent-swarm ${info.version}`);
  } catch { add('bridge-mod', false, 'Missing factorio/mod/agent-swarm_0.1.0; use the integrated Factorio implementation checkout'); }
  for (const [key, protocol] of [['gamePort', 'udp'], ['rconPort', 'tcp']]) {
    const port = config[key];
    if (!Number.isInteger(port) || port < 1024 || port > 65535) { add(key, false, 'Expected an integer port from 1024 through 65535'); continue; }
    const result = await availablePort(port, protocol);
    add(key, result.ok, `${protocol} 127.0.0.1:${port}: ${result.ok ? 'available' : `${result.detail}; stop the old demo or choose a different port`}`);
  }
  if (checkBoard) {
    try {
      const url = new URL(config.boardHost);
      if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Expected ws:// or wss://');
      const up = await reachable(url.hostname, Number(url.port || (url.protocol === 'wss:' ? 443 : 80)));
      add('board-host', up, `${url.origin}: ${up ? 'TCP reachable; database publication and authorization still need the worker check' : 'unreachable; start SpacetimeDB before workers'}`);
    } catch (error) { add('board-host', false, `Invalid/unreachable boardHost: ${error.message}`); }
  }
  return { ok: checks.every(c => c.ok), checks };
}
async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--skip-board') options.checkBoard = false;
    else if (['--root', '--binary', '--config'].includes(args[i]) && args[i + 1]) {
      const key = { '--root': 'root', '--binary': 'binary', '--config': 'configPath' }[args[i]];
      options[key] = args[++i];
    } else throw new Error('Usage: node factorio-demo/preflight.mjs [--root CHECKOUT] [--binary PATH] [--config PATH] [--skip-board]');
  }
  const result = await preflight(options);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
