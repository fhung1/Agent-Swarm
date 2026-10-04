import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { parseSwarmConfig, planGrants, planProcesses, researchSymbolEnv, scopedProcessEnv, runPolicy } from './swarm-plan.ts';

const example = fs.readFileSync(new URL('../config/swarm.example.json', import.meta.url), 'utf8');
const config = (agents: object, extra: object = {}) => parseSwarmConfig(JSON.stringify({ runId: 'pilot-1', agents, ...extra }));
const testSpend = (models: string[]) => ({pricingVersion:'unit-test-rates',models:models.map(model=>({model,
  inputUsdPerMillion:'1',cacheReadUsdPerMillion:'1',cacheWriteUsdPerMillion:'1',outputUsdPerMillion:'2'})),maxRunUsd:'10',maxWorkerUsd:'5'});

test('only the executor receives order credentials; read workers receive separate read credentials',()=>{
  const env={PATH:'/bin',ALPACA_API_KEY:'fake-paper',ALPACA_API_SECRET:'fake-secret',ALPACA_READ_API_KEY:'fake-read',ALPACA_READ_API_SECRET:'fake-read-secret',OPENAI_API_KEY:'fake-model',SEC_USER_AGENT:'fake-contact'};
  const processes=planProcesses(config({coordinator:{count:1,brain:'codex'},analyst:{count:1,brain:'codex'},skeptic:{count:0},risk:{count:1},executor:{count:1}},
    {spend:testSpend(['gpt-5.3-codex']),marketData:{everySeconds:60,symbols:['AAPL']}}));
  const analyst=scopedProcessEnv(processes.find(p=>p.role==='analyst')!,env);
  assert.equal(analyst.OPENAI_API_KEY,'fake-model');assert.equal(analyst.ALPACA_API_KEY,undefined);assert.equal(analyst.ALPACA_API_SECRET,undefined);assert.equal(analyst.ALPACA_READ_API_KEY,undefined);assert.equal(analyst.SEC_USER_AGENT,undefined);
  const executor=scopedProcessEnv(processes.find(p=>p.role==='executor')!,env);
  assert.equal(executor.ALPACA_API_KEY,'fake-paper');assert.equal(executor.ALPACA_READ_API_KEY,undefined);assert.equal(executor.OPENAI_API_KEY,undefined);assert.equal(executor.PATH,'/bin');
  for (const role of ['risk','market_data']) {
    const reader=scopedProcessEnv(processes.find(p=>p.role===role)!,env);
    assert.equal(reader.ALPACA_READ_API_KEY,'fake-read');assert.equal(reader.ALPACA_READ_API_SECRET,'fake-read-secret');
    assert.equal(reader.ALPACA_API_KEY,undefined);assert.equal(reader.ALPACA_API_SECRET,undefined);
  }
  assert.throws(() => scopedProcessEnv(processes.find(p=>p.role==='risk')!,{...env,ALPACA_READ_API_KEY:env.ALPACA_API_KEY}),/different Alpaca key IDs/);
});

test('the shipped example fails closed until its model prices and ceilings are configured', () => {
  assert.throws(() => parseSwarmConfig(example), /require explicit versioned pricing/);
});

test('agent counts expand into numbered processes per role', () => {
  const processes = planProcesses(config({
    coordinator: { count: 1, brain: 'claude' }, analyst: { count: 3, brain: 'codex', effort: 'medium' },
    skeptic: { count: 2 }, risk: { count: 1 }, executor: { count: 1 },
  }, {spend:testSpend(['claude-opus-5-5','gpt-5.3-codex'])}));
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
  assert.deepEqual(processes.find(p => p.role === 'risk')!.secrets, ['ALPACA_READ_API_KEY', 'ALPACA_READ_API_SECRET']);
});

test('optional specialists receive scoped access and coordinator routing flags', () => {
  const parsed = config({ coordinator: { count: 1 }, analyst: { count: 1 },
    valuation: { count: 1, brain: 'codex' }, portfolio: { count: 1, brain: 'codex' }, skeptic: { count: 1 } },
    { spend: { pricingVersion: 'specialists-v1', models: [{ model: 'gpt-5.3-codex', inputUsdPerMillion: '1',
      cacheReadUsdPerMillion: '1', cacheWriteUsdPerMillion: '1', outputUsdPerMillion: '1' }] } });
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

test('position review cadence gives the coordinator scoped account reads', () => {
  const parsed = config({ coordinator: { count: 1 }, analyst: { count: 1 }, skeptic: { count: 1 } },
    { positionReviews: { everyDays: 30, priceMovePct: 10 } });
  const processes = planProcesses(parsed);
  const coordinator = processes.find(p => p.role === 'coordinator')!;
  assert.equal(coordinator.accountAccess, true);
  assert.equal(coordinator.env.POSITION_REVIEW_DAYS, '30');
  assert.equal(coordinator.env.POSITION_REVIEW_PRICE_MOVE_PCT, '10');
  assert.deepEqual(coordinator.secrets, []);
  assert.throws(() => config({ coordinator: { count: 1 }, analyst: { count: 1 }, skeptic: { count: 0 } },
    { positionReviews: { everyDays: 30, priceMovePct: 10 } }), /require coordinator, analyst, and skeptic/);
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

test('paid model workers fail closed without an explicit versioned price entry', () => {
  assert.throws(() => config({ coordinator: { count: 1, brain: 'claude' } }), /require explicit versioned pricing/);
  assert.throws(() => config({ coordinator: { count: 1, brain: 'claude' } }, { spend: {
    pricingVersion: 'fixture-v1', models: [{ model: 'gpt-5.3-codex', inputUsdPerMillion: '1',
      cacheReadUsdPerMillion: '1', cacheWriteUsdPerMillion: '1', outputUsdPerMillion: '2' }],
  } }), /Missing price entry.*claude-opus-5-5/);
  assert.throws(() => config({ coordinator: { count: 1, brain: 'claude' } }, { spend: {
    pricingVersion: 'fixture-v1', models: [{ model: 'claude-opus-5-5', inputUsdPerMillion: '1.0000001',
      cacheReadUsdPerMillion: '1', cacheWriteUsdPerMillion: '1', outputUsdPerMillion: '2' }],
  } }));
});

test('operator grants install immutable rates and optional run/worker dollar ceilings', () => {
  const parsed = config({ coordinator: { count: 1, brain: 'codex', model: 'fixture-codex' } }, {
    limits: { maxInferences: 10, maxTokens: 100_000, maxConcurrent: 1, maxAttempts: 2 },
    spend: { pricingVersion: 'rates-2026-10', models: [{ model: 'fixture-codex',
      inputUsdPerMillion: '2.5', cacheReadUsdPerMillion: '1', cacheWriteUsdPerMillion: '3', outputUsdPerMillion: '10' }],
      maxRunUsd: '5.25', maxWorkerUsd: '2.00' },
  });
  const processes=planProcesses(parsed);
  const identities=new Map(processes.map(process=>[process.name,`agent-${process.name}`]));
  const commands = planGrants(parsed, processes, identities, 'owner', '', false);
  const price = commands.find(command => command.reducer === 'configure_model_price')!;
  assert.deepEqual(price.args, ['rates-2026-10', 'fixture-codex', '2500000', '1000000', '3000000', '10000000']);
  const spend = commands.find(command => command.reducer === 'configure_run_spend')!;
  assert.deepEqual(spend.args, ['pilot-1', 'rates-2026-10', '5250000', '2000000']);
  assert.ok(commands.indexOf(price) < commands.indexOf(spend));
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
