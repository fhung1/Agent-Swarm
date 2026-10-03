import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  needsRefresh, parseRiskPolicy, pendingIntentsFor, reviewProposal, summarize,
  type ProposalView, type ReservationView, type ReviewInput, type RiskDecisionView,
} from './risk-review.ts';

const policyText = fs.readFileSync(new URL('../../config/risk-policy.json', import.meta.url), 'utf8');
const policy = parseRiskPolicy(policyText);
const now = new Date('2026-10-05T15:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

const proposal: ProposalView = {
  id: 'proposal.th-1', runId: 'demo', thesisId: 'th-1', symbol: 'AAPL', side: 'buy', quantity: '2',
  orderType: 'market', limitPrice: '', status: 'proposed', createdAt: minutesAgo(1),
};
const input: ReviewInput = {
  proposal, runStatus: 'active', policy, now, marketOpen: true, pendingIntents: [],
  account: { status: 'ACTIVE', buyingPower: '5000', positionsJson: '[]', openOrdersJson: '[]', capturedAt: now },
  quotes: [{ symbol: 'AAPL', bidPrice: '199.90', askPrice: '200.10', asOf: new Date(now.getTime() - 5_000) }],
};

test('the shipped policy file is valid', () => {
  assert.equal(policy.version, 'paper-pilot-1');
  assert.ok(policy.allowedSymbols.includes('AAPL'));
});

test('policy parsing rejects unknown keys and unsafe values', () => {
  const base = JSON.parse(policyText);
  assert.throws(() => parseRiskPolicy(JSON.stringify({ ...base, autoApprove: true })));
  assert.throws(() => parseRiskPolicy(JSON.stringify({ ...base, maxOrderNotional: -1 })));
  assert.throws(() => parseRiskPolicy(JSON.stringify({ ...base, allowedSymbols: ['aapl'] })));
});

test('a valid proposal passes and a missing quote rejects', () => {
  const pass = reviewProposal(input);
  assert.equal(pass.outcome, 'pass');
  assert.deepEqual(pass.failed, []);
  const reject = reviewProposal({ ...input, quotes: [] });
  assert.equal(reject.outcome, 'reject');
  assert.ok(reject.failed.includes('quote_fresh'));
});

test('a stale stored clock counts as a closed market', () => {
  assert.ok(reviewProposal({ ...input, marketOpen: false }).failed.includes('market_open'));
});

const reservation = (proposalId: string, clientOrderId = ''): ReservationView =>
  ({ proposalId, accountId: 'acct-1', quantity: '2', notional: '400.2', clientOrderId });
const decision = (proposalId: string, expiresAt: Date): RiskDecisionView =>
  ({ id: `risk.${proposalId}`, proposalId, outcome: 'pass', expiresAt, policyId: 'paper-pilot-1', snapshotId: 'snap-1' });

test('pending intents follow the module reservation rules', () => {
  const other = { ...proposal, id: 'p-other', status: 'risk_passed' };
  const submitted = { ...proposal, id: 'p-submitted', status: 'submitting' };
  const filled = { ...proposal, id: 'p-filled', status: 'submitting' };
  const expired = { ...proposal, id: 'p-expired', status: 'risk_passed' };
  const proposals = new Map([proposal, other, submitted, filled, expired].map(p => [p.id, p]));
  const decisions = new Map([
    ['p-other', decision('p-other', minutesAgo(-5))],
    ['p-submitted', decision('p-submitted', minutesAgo(10))], // expired, but the order may be live
    ['p-filled', decision('p-filled', minutesAgo(-5))],
    ['p-expired', decision('p-expired', minutesAgo(10))],
  ]);
  const orders = new Map([['p-submitted', { proposalId: 'p-submitted', status: 'accepted' }],
    ['p-filled', { proposalId: 'p-filled', status: 'filled' }]]);
  const reservations = ['p-other', 'p-submitted', 'p-filled', 'p-expired', proposal.id].map(id => reservation(id))
    .concat({ ...reservation('p-elsewhere'), accountId: 'acct-2' });
  const intents = pendingIntentsFor(proposal.id, 'acct-1', reservations, proposals, decisions, orders, now);
  assert.deepEqual(intents.map(i => i.proposalId).sort(), ['p-other', 'p-submitted']);
});

test('an unresolvable reservation fails closed', () => {
  assert.throws(() => pendingIntentsFor(proposal.id, 'acct-1', [reservation('p-hidden')], new Map(), new Map(), new Map(), now),
    /no visible proposal/);
});

test('passed proposals refresh only when unsubmitted and stale', () => {
  const fresh = decision(proposal.id, minutesAgo(-5));
  assert.equal(needsRefresh(fresh, undefined, 'snap-1', 'paper-pilot-1', now), false);
  assert.equal(needsRefresh({ ...fresh, expiresAt: minutesAgo(1) }, undefined, 'snap-1', 'paper-pilot-1', now), true);
  assert.equal(needsRefresh(fresh, undefined, 'snap-2', 'paper-pilot-1', now), true);
  assert.equal(needsRefresh(fresh, undefined, 'snap-1', 'paper-pilot-2', now), true);
  assert.equal(needsRefresh({ ...fresh, expiresAt: minutesAgo(1) }, { proposalId: proposal.id, status: 'accepted' }, 'snap-2', 'paper-pilot-1', now), false);
  assert.equal(needsRefresh(undefined, undefined, 'snap-1', 'paper-pilot-1', now), false);
});

test('summaries name the order, failures, and expiry', () => {
  assert.match(summarize(proposal, 'pass', [], 'paper-pilot-1', now),
    /^Risk pass for proposal\.th-1 \(buy 2 AAPL market\) under policy paper-pilot-1; valid until 2026-10-05T15:00:00\.000Z$/);
  assert.equal(summarize(proposal, 'reject', ['quote_fresh'], 'paper-pilot-1', now),
    'Risk reject for proposal.th-1 (buy 2 AAPL market) under policy paper-pilot-1; failed: quote_fresh');
});
