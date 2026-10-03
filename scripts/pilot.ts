#!/usr/bin/env node
// Node 24+: validate and materialize input for the existing swarm supervisor. No broker/model/database calls.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePilotConfig, missingPilotEnvironment } from '../src/pilot-config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command, file, ...extra] = process.argv.slice(2);
try {
  if (!['check', 'prepare'].includes(command) || !file || extra.length) {
    throw new Error('Usage: node scripts/pilot.ts <check|prepare> <pilot.json>');
  }
  const config = parsePilotConfig(readFileSync(resolve(file), 'utf8'));
  const missing = missingPilotEnvironment(config, process.env);
  if (missing.length) throw new Error(`Missing environment: ${missing.join(', ')}`);
  console.log(`Valid paper pilot ${config.swarm.runId}: ${config.policy.allowedSymbols.join(', ')}; benchmark ${config.benchmark}`);
  console.log(`Operator review every ${config.reviewEveryHours}h; holding horizon ${config.holdingHorizonDays} days (metadata, not automatic scheduling).`);
  console.log('Credentials are present; account identity, model access and feed entitlement still require connectivity acceptance.');
  if (command === 'prepare') {
    // Exclusive directory creation prevents accidental replacement of a previously prepared run.
    const directory = resolve(root, 'logs', 'pilots', config.swarm.runId);
    mkdirSync(dirname(directory), { recursive: true });
    mkdirSync(directory);
    const policyFile = resolve(directory, 'risk-policy.json');
    const swarmFile = resolve(directory, 'swarm.json');
    writeFileSync(policyFile, JSON.stringify(config.policy, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(swarmFile, JSON.stringify({ ...config.swarm, riskPolicyFile: policyFile }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(resolve(directory, 'pilot.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Prepared ${relative(root, directory)}. From the repository root (Node 24+):`);
    for (const action of ['plan', 'register', 'grants', 'grants --apply', 'up']) {
      // Paths are JSON quoted for display; use literal paths without expansion when copying.
      console.log(`node scripts/swarm.ts ${action} --config ${JSON.stringify(relative(root, swarmFile))}`);
    }
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
