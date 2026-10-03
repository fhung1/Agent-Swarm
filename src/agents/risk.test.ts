import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRisk, type RiskInput, type RiskPolicy } from './risk.ts';

const now = new Date('2026-10-05T15:00:00Z');
const policy: RiskPolicy = {
  version: 'test-1', allowedSymbols: ['AAPL', 'MSFT'], longOnly: true,
  maxOrderNotional: 1_000, maxPositionNotional: 2_000, maxQuoteAgeMs: 60_000,
  maxAccountAgeMs: 300_000, maxLimitDeviation: 0.05, approvalTtlMs: 600_000,
  maxProposalAgeMs: 900_000, requireMarketOpen: true,
};

function input(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    proposal: {
      id: 'p-1', symbol: 'AAPL', side: 'buy', quantity: '2', orderType: 'market', limitPrice: '',
      createdAt: new Date(now.getTime() - 60_000),
    },
    pendingIntents: [],
    quote: { symbol: 'AAPL', bidPrice: '199.90', askPrice: '200.10', asOf: new Date(now.getTime() - 10_000) },
    account: {
      status: 'ACTIVE', buyingPower: '5000', positionsJson: '[]', openOrdersJson: '[]',
      capturedAt: new Date(now.getTime() - 30_000),
    },
    runStatus: 'active', marketOpen: true, now,
    ...overrides,
  };
}

function failed(result: ReturnType<typeof evaluateRisk>): string[] {
  return result.checks.filter(c => !c.pass).map(c => c.name);
}

test('passes a small fresh buy', () => {
  const result = evaluateRisk(input(), policy);
  assert.deepEqual(failed(result), []);
  assert.equal(result.outcome, 'pass');
  assert.equal(result.expiresAt.getTime(), now.getTime() + policy.approvalTtlMs);
});

test('rejects stale quotes and stale accounts', () => {
  const stale = input({
    quote: { symbol: 'AAPL', bidPrice: '199.90', askPrice: '200.10', asOf: new Date(now.getTime() - 120_000) },
    account: { ...input().account!, capturedAt: new Date(now.getTime() - 600_000) },
  });
  const result = evaluateRisk(stale, policy);
  assert.equal(result.outcome, 'reject');
  assert.deepEqual(failed(result), ['quote_fresh', 'account_fresh']);
});

test('rejects symbols outside the universe, closed markets and paused runs', () => {
  const result = evaluateRisk(input({
    proposal: { ...input().proposal, symbol: 'TSLA' }, marketOpen: false, runStatus: 'paused',
  }), policy);
  assert.deepEqual(failed(result).slice(0, 3), ['run_active', 'symbol_allowed', 'market_open']);
});

test('a closed market passes only when the policy allows queued orders', () => {
  assert.deepEqual(failed(evaluateRisk(input({ marketOpen: false }), policy)), ['market_open']);
  assert.equal(evaluateRisk(input({ marketOpen: false }), { ...policy, requireMarketOpen: false }).outcome, 'pass');
});

test('rejects stale proposals', () => {
  const proposal = { ...input().proposal, createdAt: new Date(now.getTime() - 3_600_000) };
  assert.deepEqual(failed(evaluateRisk(input({ proposal }), policy)), ['proposal_fresh']);
});

test('rejects orders over the notional cap', () => {
  const result = evaluateRisk(input({ proposal: { ...input().proposal, quantity: '6' } }), policy);
  assert.deepEqual(failed(result), ['order_notional']);
});

test('counts pending buys against buying power and position limit', () => {
  const account = {
    ...input().account!, buyingPower: '1000',
    positionsJson: JSON.stringify([{ symbol: 'AAPL', qty: '8', market_value: '1700' }]),
    openOrdersJson: JSON.stringify([{ symbol: 'MSFT', side: 'buy', qty: '2', filled_qty: '0', limit_price: '400' }]),
  };
  const result = evaluateRisk(input({ account }), policy);
  assert.deepEqual(failed(result), ['buying_power', 'position_limit']);
});

test('rejects a duplicate pending intent', () => {
  const account = {
    ...input().account!,
    openOrdersJson: JSON.stringify([{ symbol: 'AAPL', side: 'buy', qty: '1', filled_qty: '0' }]),
  };
  assert.ok(failed(evaluateRisk(input({ account }), policy)).includes('no_duplicate_intent'));
});

test('rejects a second proposal for the same intent that has not reached Alpaca', () => {
  const pendingIntents = [{ proposalId: 'p-1', symbol: 'AAPL', side: 'buy', quantity: '1', notional: '200' }];
  assert.equal(evaluateRisk(input({ pendingIntents }), policy).outcome, 'pass');
  pendingIntents.push({ proposalId: 'p-0', symbol: 'AAPL', side: 'buy', quantity: '1', notional: '200' });
  assert.deepEqual(failed(evaluateRisk(input({ pendingIntents }), policy)), ['no_duplicate_intent']);
});

test('pending notional sells count against held shares', () => {
  const account = {
    ...input().account!,
    positionsJson: JSON.stringify([{ symbol: 'AAPL', qty: '3', market_value: '600' }]),
    openOrdersJson: JSON.stringify([{ symbol: 'AAPL', side: 'sell', qty: null, notional: '400' }]),
  };
  const proposal = { ...input().proposal, side: 'sell', quantity: '2' };
  assert.ok(failed(evaluateRisk(input({ account, proposal }), policy)).includes('long_only_sell'));
});

test('long-only sells cannot exceed held shares net of pending sells', () => {
  const account = {
    ...input().account!,
    positionsJson: JSON.stringify([{ symbol: 'AAPL', qty: '3', market_value: '600' }]),
  };
  const sell = (quantity: string) => ({ ...input().proposal, side: 'sell', quantity });
  assert.equal(evaluateRisk(input({ account, proposal: sell('3') }), policy).outcome, 'pass');
  assert.deepEqual(failed(evaluateRisk(input({ account, proposal: sell('4') }), policy)), ['long_only_sell']);
});

test('rejects limit prices far from the quote', () => {
  const proposal = { ...input().proposal, orderType: 'limit', limitPrice: '150' };
  assert.deepEqual(failed(evaluateRisk(input({ proposal }), policy)), ['limit_near_quote']);
});

test('rejects malformed account JSON instead of throwing', () => {
  const account = { ...input().account!, positionsJson: '{oops' };
  const result = evaluateRisk(input({ account }), policy);
  assert.equal(result.outcome, 'reject');
  assert.ok(failed(result).includes('account_parse'));
});

test('rejects malformed account rows and numeric fields instead of treating them as zero', () => {
  for (const positionsJson of ['[null]', '[1]', '[[]]', '[{"symbol":"AAPL","qty":"bad","market_value":"bad"}]']) {
    assert.ok(failed(evaluateRisk(input({ account: { ...input().account!, positionsJson } }), policy)).includes('account_parse'));
  }
  for (const openOrdersJson of ['[null]', '[{"symbol":"MSFT","side":"buy","qty":"bad","filled_qty":"bad"}]']) {
    assert.ok(failed(evaluateRisk(input({ account: { ...input().account!, openOrdersJson } }), policy)).includes('account_parse'));
  }
});

test('requires a fresh price for an unpriced order in another symbol', () => {
  const account = { ...input().account!, buyingPower: '700', openOrdersJson: '[{"symbol":"MSFT","side":"buy","qty":"1","filled_qty":"0"}]' };
  assert.ok(failed(evaluateRisk(input({ account }), policy)).includes('pending_exposure'));
  const quotes = [{ symbol: 'MSFT', bidPrice: '399', askPrice: '400', asOf: now }];
  assert.ok(failed(evaluateRisk(input({ account, quotes }), policy)).includes('buying_power'));
});

test('reserves buying power across symbols before broker submission', () => {
  const pendingIntents = [{ proposalId: 'other', symbol: 'MSFT', side: 'buy', quantity: '1', notional: '400' }];
  assert.ok(failed(evaluateRisk(input({ account: { ...input().account!, buyingPower: '700' }, pendingIntents }), policy)).includes('buying_power'));
});

test('checks aggregate exposure, pending order count, and daily loss', () => {
  const bounded = { ...policy, maxPortfolioNotional: 300, maxOpenOrders: 1, maxDailyLoss: 100 };
  const pendingIntents = [{ proposalId: 'other', symbol: 'MSFT', side: 'buy', quantity: '1', notional: '200' }];
  const result = evaluateRisk(input({ pendingIntents, account: { ...input().account!, dailyPnl: '-150' } }), bounded);
  assert.ok(failed(result).includes('portfolio_limit'));
  assert.ok(failed(result).includes('open_order_limit'));
  assert.ok(failed(result).includes('daily_loss'));
});

test('rejects invalid policy limits', () => {
  assert.equal(evaluateRisk(input(), { ...policy, maxOrderNotional: NaN }).outcome, 'reject');
});
