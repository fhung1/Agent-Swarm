import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePilotConfig, missingPilotEnvironment } from './pilot-config.ts';

function fixture() {
  const c = JSON.parse(readFileSync('config/paper-pilot.example.json', 'utf8'));
  c.swarm.accountId = 'paper-test-account';
  for (const role of ['coordinator', 'analyst', 'skeptic']) c.swarm.agents[role].model = 'test-model';
  c.swarm.spend = { pricingVersion: 'fixture-v1', models: [{ model: 'test-model',
    inputUsdPerMillion: '1', cacheReadUsdPerMillion: '1', cacheWriteUsdPerMillion: '1', outputUsdPerMillion: '1' }],
    maxRunUsd: '10', maxWorkerUsd: '5' };
  return c;
}
test('pilot preserves explicit policy, model budgets and review metadata', () => {
  const c = parsePilotConfig(JSON.stringify(fixture()));
  assert.equal(c.policy.maxPortfolioNotional, 5000);
  assert.equal(c.swarm.marketData?.everySeconds, 30);
  assert.equal(c.swarm.limits?.maxConcurrent, 2);
  assert.equal(c.swarm.spend?.pricingVersion, 'fixture-v1');
  assert.equal(c.reviewEveryHours, 24);
});
test('pilot refuses incomplete sample and inconsistent executable plans', () => {
  assert.throws(() => parsePilotConfig(readFileSync('config/paper-pilot.example.json', 'utf8')));
  const edits = [
    (c: ReturnType<typeof fixture>) => { c.mode = 'live'; },
    (c: ReturnType<typeof fixture>) => { c.swarm.accountId = ''; },
    (c: ReturnType<typeof fixture>) => { delete c.swarm.limits; },
    (c: ReturnType<typeof fixture>) => { c.swarm.agents.analyst.brain = 'rules'; },
    (c: ReturnType<typeof fixture>) => { c.swarm.agents.executor.count = 0; },
    (c: ReturnType<typeof fixture>) => { c.swarm.research.evidence = 'fixture'; },
    (c: ReturnType<typeof fixture>) => { c.swarm.research.symbols.push('TSLA'); },
    (c: ReturnType<typeof fixture>) => { c.swarm.marketData.symbols.push('AAPL'); },
    (c: ReturnType<typeof fixture>) => { c.swarm.marketData.everySeconds = 300; },
    (c: ReturnType<typeof fixture>) => { c.policy.maxPortfolioNotional = 1; },
    (c: ReturnType<typeof fixture>) => { c.policy.maxOpenOrders = 1.5; },
    (c: ReturnType<typeof fixture>) => { c.policy.maxDailyLoss = 0; },
    (c: ReturnType<typeof fixture>) => { c.reviewEveryHours = 1000; },
    (c: ReturnType<typeof fixture>) => { c.swarm.ALPACA_API_KEY = 'secret'; },
  ];
  for (const edit of edits) { const c = fixture(); edit(c); assert.throws(() => parsePilotConfig(JSON.stringify(c))); }
});
test('missing environment reports names only and supports explicit Anthropic auth token', () => {
  const c = parsePilotConfig(JSON.stringify(fixture()));
  assert.deepEqual(missingPilotEnvironment(c, {}), ['ALPACA_API_KEY', 'ALPACA_API_SECRET', 'ALPACA_READ_API_KEY', 'ALPACA_READ_API_SECRET', 'ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'SEC_USER_AGENT']);
  const env = { ALPACA_API_KEY: 'sensitive', ALPACA_API_SECRET: 'sensitive', ALPACA_READ_API_KEY: 'read-only', ALPACA_READ_API_SECRET: 'read-only', ANTHROPIC_AUTH_TOKEN: 'sensitive', OPENAI_API_KEY: 'sensitive', SEC_USER_AGENT: 'team contact@example.com' };
  assert.deepEqual(missingPilotEnvironment(c, env), []);
  assert.deepEqual(missingPilotEnvironment(c, { ...env, ALPACA_API_SECRET: ' ' }), ['ALPACA_API_SECRET']);
});
