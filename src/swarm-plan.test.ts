import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { parseSwarmConfig, planGrants, planProcesses, researchSymbolEnv, scopedProcessEnv, runPolicy } from './swarm-plan.ts';

const example = fs.readFileSync(new URL('../config/swarm.example.json', import.meta.url), 'utf8');
const config = (agents: object, extra: object = {}) => parseSwarmConfig(JSON.stringify({ runId: 'pilot-1', agents, ...extra }));

test('research workers receive model secrets while broker services receive paper secrets',()=>{
  const env={PATH:'/bin',ALPACA_API_KEY:'fake-paper',ALPACA_API_SECRET:'fake-secret',OPENAI_API_KEY:'fake-model',SEC_USER_AGENT:'fake-contact'};
  const processes=planProcesses(config({coordinator:{count:1,brain:'codex'},analyst:{count:1,brain:'codex'},skeptic:{count:0},risk:{count:1},executor:{count:1}}));
  const analyst=scopedProcessEnv(processes.find(p=>p.role==='analyst')!,env);
  assert.equal(analyst.OPENAI_API_KEY,'fake-model');assert.equal(analyst.ALPACA_API_KEY,undefined);assert.equal(analyst.ALPACA_API_SECRET,undefined);assert.equal(analyst.SEC_USER_AGENT,undefined);
  const executor=scopedProcessEnv(processes.find(p=>p.role==='executor')!,env);
  assert.equal(executor.ALPACA_API_KEY,'fake-paper');assert.equal(executor.OPENAI_API_KEY,undefined);assert.equal(executor.PATH,'/bin');
});

test('the shipped example config is valid', () => {
  const parsed = parseSwarmConfig(example);
  assert.ok(planProcesses(parsed).length > 0);
});

test('agent counts expand into numbered processes per role', () => {
  const processes = planProcesses(config({
    coordinator: { count: 1, brain: 'claude' }, analyst: { count: 3, brain: 'codex', effort: 'medium' },
    skeptic: { count: 2 }, risk: { count: 1 }, executor: { count: 1 },
  }));
  assert.deepEqual(processes.map(p => p.name), [
    'swarm-coordinator-1', 'swarm-analyst-1', 'swarm-analyst-2', 'swarm-analyst-3',
    'swarm-skeptic-1', 'swarm-skeptic-2', 'swarm-risk-1', 'swarm-executor-1',
  ]);
  const analyst = processes.find(p => p.name === 'swarm-analyst-2')!;
  assert.equal(analyst.env.AGENT_BRAIN, 'codex');
  assert.equal(analyst.env.AGENT_EFFORT, 'medium');
  assert.equal(analyst.env.RUN_ID, 'pilot-1');
  assert.deepEqual(analyst.secrets, ['OPENAI_API_KEY']);
  assert.equal(processes.find(p => p.role === 'skeptic')!.env.AGENT_BRAIN, 'rules');
  assert.deepEqual(processes.find(p => p.role === 'risk')!.secrets, ['ALPACA_API_KEY', 'ALPACA_API_SECRET']);
});

test('optional specialists receive scoped access and coordinator routing flags', () => {
  const parsed = config({ coordinator: { count: 1 }, analyst: { count: 1 },
    valuation: { count: 1, brain: 'codex' }, portfolio: { count: 1, brain: 'codex' }, skeptic: { count: 1 } });
  const processes = planProcesses(parsed);
  const portfolio = processes.find(p => p.role === 'portfolio')!;
  const valuation = processes.find(p => p.role === 'valuation')!;
  assert.equal(portfolio.accountAccess, true);
  assert.equal(valuation.accountAccess, false);
  assert.deepEqual(portfolio.secrets, ['OPENAI_API_KEY']);
  assert.equal(processes.find(p => p.role === 'coordinator')!.env.TEAM_VALUATION, '1');
  assert.equal(processes.find(p => p.role === 'coordinator')!.env.TEAM_PORTFOLIO, '1');
  const env = scopedProcessEnv(portfolio, { ALPACA_API_KEY: 'paper', ALPACA_API_SECRET: 'paper', OPENAI_API_KEY: 'model' });
  assert.equal(env.ALPACA_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, 'model');
  const identities = new Map(processes.map((p, i) => [p.name, `id-${i}`]));
  const grants = planGrants(parsed, processes, identities, 'owner', 'acct-1', false);
  assert.equal(grants.filter(command => command.reducer === 'grant_account_access').length, 1);
  assert.throws(() => config({ coordinator: { count: 1 }, analyst: { count: 0 }, valuation: { count: 1 } }), /need an analyst/);
});

test('roles that act on the whole run or account are limited to one', () => {
  for (const role of ['coordinator', 'risk', 'executor']) {
    assert.throws(() => config({ [role]: { count: 2 }, ...(role === 'executor' ? { risk: { count: 1 } } : {}) }));
  }
  assert.throws(() => config({ analyst: { count: 21 } }));
});

test('inconsistent role mixes are refused', () => {
  assert.throws(() => config({ coordinator: { count: 0 }, analyst: { count: 1 } }), /need a coordinator/);
  assert.throws(() => config({ executor: { count: 1 } }), /needs the risk broker/);
  assert.throws(() => config({ analyst: { count: 1, brain: 'gpt' } }));
  assert.throws(() => config({}, { secrets: { ALPACA_API_KEY: 'x' } }), /Unrecognized key/);
});

test('market data and research add periodic and one-shot processes', () => {
  const processes = planProcesses(config({}, {
    marketData: { everySeconds: 300, symbols: ['AAPL', 'MSFT'] }, research: { symbols: ['AAPL'], evidence: 'sec' },
  }));
  const market = processes.find(p => p.role === 'market_data')!;
  assert.equal(market.periodicSeconds, 300);
  assert.equal(market.env.ALPACA_SYMBOLS, 'AAPL,MSFT');
  assert.equal(market.tokenFileEnv, 'SPACETIMEDB_TOKEN_FILE');
  const ingestor = processes.find(p => p.role === 'ingestor')!;
  assert.equal(ingestor.script, 'sec-ingestor.js');
  assert.ok(ingestor.oneShot);
  assert.deepEqual(researchSymbolEnv(ingestor, 'MSFT'), { SYMBOLS: 'MSFT' });
  const fixture = planProcesses(config({}, { research: { symbols: ['NVDA'], evidence: 'fixture' } })).find(p => p.role === 'ingestor')!;
  assert.deepEqual(researchSymbolEnv(fixture, 'NVDA'), { SYMBOL: 'NVDA' });
  assert.throws(() => researchSymbolEnv(ingestor, 'MSFT,AAPL'), /Invalid research symbol/);
});

test('grants cover every process, account access only where needed, and a run-specific policy', () => {
  const parsed = config({ coordinator: { count: 1 }, analyst: { count: 1 }, skeptic: { count: 0 }, risk: { count: 1 }, executor: { count: 1 } },
    { limits: { maxInferences: 20, maxTokens: 500000, maxConcurrent: 2, maxAttempts: 3 } });
  const processes = planProcesses(parsed);
  const identities = new Map(processes.map((p, i) => [p.name, `id-${i}`]));
  const policy = runPolicy(JSON.stringify({ version: 'paper-pilot-1', longOnly: true }), 'pilot-1');
  assert.equal(policy.id, 'paper-pilot-1.pilot-1');
  assert.equal(JSON.parse(policy.json).version, 'paper-pilot-1.pilot-1');
  const commands = planGrants(parsed, processes, identities, 'owner', 'acct-1', false, policy);
  assert.deepEqual(commands.slice(0, 3).map(c => c.reducer), ['grant_agent', 'create_run', 'configure_run_limits']);
  assert.equal(commands.filter(c => c.reducer === 'grant_account_access').length, 2);
  assert.equal(commands.at(-1)!.reducer, 'add_risk_policy');
  assert.ok(!planGrants(parsed, processes, identities, 'owner', 'acct-1', true, policy).some(c => c.reducer === 'create_run'));
  assert.throws(() => planGrants(parsed, processes, identities, 'owner', '', true, policy), /account ID/);
  assert.throws(() => planGrants(parsed, processes, new Map(), 'owner', 'acct-1', true), /swarm register/);
});
