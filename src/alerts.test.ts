import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAlerts, parseAlertThresholds, type AlertInput, type AlertThresholds } from './alerts.ts';

const now = new Date('2026-10-03T15:00:00.000Z');
const thresholds: AlertThresholds = {
  accountSnapshotMaxAgeMs: 1_000, quoteMaxAgeMs: 1_000, stuckOrderMs: 1_000, serviceSilentMs: 1_000,
};
const policy = {
  version: 'test', allowedSymbols: ['AAPL'], longOnly: true, maxOrderNotional: 100,
  maxPositionNotional: 100, maxQuoteAgeMs: 1_000, maxAccountAgeMs: 1_000,
  maxLimitDeviation: 0.05, approvalTtlMs: 1_000, maxProposalAgeMs: 1_000, requireMarketOpen: true,
  maxPortfolioNotional: 150,
};
const healthy: AlertInput = {
  accountId: 'paper-1', now, marketOpen: true, universeSymbols: ['AAPL'],
  snapshot: { accountStatus: 'ACTIVE', capturedAt: now, positionsJson: '[]', openOrdersJson: '[]' },
  quotes: [{ symbol: 'AAPL', bidPrice: '99', askPrice: '101', asOf: now }],
  orders: [], services: [{ role: 'executor', status: 'online', lastSeen: now }], policy,
  marketClockLastSeen: now,
  reconciliation: { status: 'matched', details: 'Matched' },
};

function rules(input: AlertInput): Set<string> {
  return new Set(evaluateAlerts(input, thresholds).map(alert => alert.rule));
}

test('stale account and in-session quotes alert, then resolve when fresh values arrive', () => {
  const stale: AlertInput = {
    ...healthy,
    snapshot: { ...healthy.snapshot!, capturedAt: new Date(now.getTime() - 10_000) },
    quotes: [],
  };
  assert.ok(rules(stale).has('account_snapshot_stale'));
  assert.ok(rules(stale).has('market_quote_stale'));

  const refreshed: AlertInput = { ...stale, snapshot: healthy.snapshot, quotes: healthy.quotes };
  assert.equal(rules(refreshed).has('account_snapshot_stale'), false);
  assert.equal(rules(refreshed).has('market_quote_stale'), false);
  assert.equal(rules({ ...stale, marketOpen: false }).has('market_quote_stale'), false);
});

test('missing or stale market clock is a critical data alert and clears on a fresh clock', () => {
  assert.ok(rules({ ...healthy, marketClockLastSeen: undefined }).has('market_clock_stale'));
  assert.ok(rules({ ...healthy, marketClockLastSeen: new Date(now.getTime() - 5_000) }).has('market_clock_stale'));
  assert.equal(rules(healthy).has('market_clock_stale'), false);
});

test('stuck and rejected paper orders produce separate alerts', () => {
  const input: AlertInput = {
    ...healthy,
    orders: [
      { id: 'stuck-1', status: 'accepted', updatedAt: new Date(now.getTime() - 5_000) },
      { id: 'reject-1', status: 'rejected', updatedAt: now },
    ],
  };
  const alerts = evaluateAlerts(input, thresholds);
  assert.ok(alerts.some(alert => alert.rule === 'order_stuck' && alert.subject === 'stuck-1'));
  assert.ok(alerts.some(alert => alert.rule === 'order_rejected' && alert.subject === 'reject-1'));
  assert.equal(rules({ ...input, orders: [] }).has('order_stuck'), false);
});

test('silent executor, broken trade stream and unresolved account mismatch alert', () => {
  const input: AlertInput = {
    ...healthy,
    services: [{ role: 'executor', status: 'offline', lastSeen: new Date(now.getTime() - 5_000) }],
    tradeStreamExpected: true, tradeStreamConnected: true,
    tradeStreamLastMessageAt: new Date(now.getTime() - 5_000),
    reconciliation: { status: 'mismatch', details: 'External position detected' },
  };
  const found = rules(input);
  assert.ok(found.has('executor_silent'));
  assert.ok(found.has('trade_stream_silent'));
  assert.ok(found.has('account_mismatch'));
  assert.equal(rules(healthy).has('account_mismatch'), false);
});

test('exposure over position or portfolio policy limits alerts with stable subjects', () => {
  const input: AlertInput = {
    ...healthy,
    snapshot: { ...healthy.snapshot!, positionsJson: JSON.stringify([{ symbol: 'AAPL', qty: '3', market_value: '200' }]) },
  };
  const alerts = evaluateAlerts(input, thresholds).filter(alert => alert.rule === 'exposure_breach');
  assert.deepEqual(alerts.map(alert => alert.subject).sort(), ['paper-1:AAPL', 'paper-1:portfolio']);
  assert.equal(rules(healthy).has('exposure_breach'), false);
});

test('malformed account state raises a high-severity data alert and invalid thresholds are refused', () => {
  const input: AlertInput = {
    ...healthy,
    snapshot: { ...healthy.snapshot!, positionsJson: '{bad json' },
  };
  assert.ok(rules(input).has('account_data_invalid'));
  assert.throws(() => evaluateAlerts(healthy, { ...thresholds, quoteMaxAgeMs: 0 }), /Invalid alert threshold/);
  assert.deepEqual(parseAlertThresholds(thresholds), thresholds);
  assert.throws(() => parseAlertThresholds({ ...thresholds, mystery: 1 }), /must contain exactly/);
});
