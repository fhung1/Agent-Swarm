import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCritiqueMessageArgs, toProposalArgs, toPublishThesisArgs, toSpecialistMessageArgs, type CoordinatorOutput, type ThesisView } from './roles.ts';

const thesis: ThesisView = {
  id: 'th-1', runId: 'demo', symbol: 'AAPL', bullCase: 'b', bearCase: 'b',
  assumptions: 'a', invalidation: 'i', evidenceRefs: 'obs-1',
};
const analyst = { bull_case: 'Up', bear_case: 'Down', assumptions: 'None', invalidation: 'Drop below 150', evidence_ids: ['obs-1', 'obs-1'] };
const ids = { thesisId: 'th-1', runId: 'demo', taskId: 't-1', symbol: 'AAPL' };

test('thesis keeps deduplicated cited evidence', () => {
  assert.equal(toPublishThesisArgs(analyst, ids, new Set(['obs-1'])).evidenceRefs, 'obs-1');
});

test('thesis rejects invented or missing evidence', () => {
  assert.throws(() => toPublishThesisArgs({ ...analyst, evidence_ids: ['made-up'] }, ids, new Set(['obs-1'])), /unknown evidence/);
  assert.throws(() => toPublishThesisArgs({ ...analyst, evidence_ids: [] }, ids, new Set(['obs-1'])), /no evidence/);
});

const trade: CoordinatorOutput = { outcome: 'trade', rationale: 'r', side: 'buy', quantity: '1', order_type: 'market', limit_price: null };
const pids = { proposalId: 'p-1', runId: 'demo', thesis };
const quote = { id: 'obs-1', symbol: 'AAPL', feed: 'iex', bidPrice: '199.90', askPrice: '200.10', asOf: new Date().toISOString() };

test('abstain produces no proposal', () => {
  assert.equal(toProposalArgs({ ...trade, outcome: 'abstain' }, pids, undefined, 1000), undefined);
});

test('proposal enforces the notional cap and reducer formats', () => {
  assert.deepEqual(toProposalArgs(trade, pids, quote, 1000), {
    id: 'p-1', runId: 'demo', thesisId: 'th-1', symbol: 'AAPL', side: 'buy', quantity: '1', orderType: 'market', limitPrice: '',
  });
  assert.throws(() => toProposalArgs({ ...trade, quantity: '5' }, pids, quote, 1000), /exceeds cap/);
  assert.throws(() => toProposalArgs({ ...trade, quantity: '1e3' }, pids, quote, 1000), /Invalid quantity/);
  assert.throws(() => toProposalArgs(trade, pids, undefined, 1000), /No quote/);
  assert.throws(() => toProposalArgs({ ...trade, order_type: 'limit', limit_price: null }, pids, quote, 1000), /Invalid limit price/);
  assert.equal(toProposalArgs({ ...trade, order_type: 'limit', limit_price: '200.5' }, pids, quote, 1000)?.limitPrice, '200.5');
});

test('critique body is clipped to fit the message limit', () => {
  const long = Array.from({ length: 20 }, () => 'x'.repeat(1000));
  const args = toCritiqueMessageArgs(
    { verdict: 'weakens', objections: long, missing_evidence: long, unsupported_claims: long },
    { messageId: 'm-1', runId: 'demo', taskId: 't-1', symbol: 'AAPL', thesisId: 'th-1' });
  assert.equal(args.kind, 'challenge');
  assert.equal(args.recipientRole, 'coordinator');
  assert.ok(args.body.length <= 4096);
  assert.equal(JSON.parse(args.body).objections.length, 5);
});

test('proposal rejects unusable quote prices before recording a trade', () => {
  for (const askPrice of ['0', '-1', 'NaN', 'Infinity', '']) {
    assert.throws(() => toProposalArgs(trade, pids, { ...quote, askPrice }, 1000), /Invalid order sizing price/);
  }
});

test('critique bounds include JSON escaping', () => {
  for (const character of ['"', '\\', '\u0000']) {
    const list = Array.from({ length: 5 }, () => character.repeat(250));
    const args = toCritiqueMessageArgs(
      { verdict: 'weakens', objections: list, missing_evidence: list, unsupported_claims: list },
      { messageId: 'm-1', runId: 'demo', taskId: 't-1', symbol: 'AAPL', thesisId: 'th-1' });
    assert.ok(args.body.length <= 4096);
    assert.equal(JSON.parse(args.body).objections.length, 5);
  }
});

test('valuation scenarios must be ordered, positive, and cited', () => {
  const output = { status: 'ready' as const, bear_value: '80', base_value: '100', bull_value: '130',
    assumptions: 'Stable earnings', risks: 'Margin compression', evidence_ids: ['obs-1'] };
  const message = toSpecialistMessageArgs('valuation', output,
    { messageId: 'valuation.t-1.report', runId: 'demo', taskId: 'valuation.t-1', symbol: 'AAPL', thesisId: 'th-1' },
    new Set(['obs-1']));
  assert.equal(message.kind, 'valuation');
  assert.equal(JSON.parse(message.body).base_value, '100');
  assert.throws(() => toSpecialistMessageArgs('valuation', { ...output, bull_value: '70' },
    { messageId: 'm', runId: 'demo', taskId: 't', symbol: 'AAPL', thesisId: 'th-1' }, new Set(['obs-1'])), /ordered positive/);
  assert.throws(() => toSpecialistMessageArgs('valuation', { ...output, evidence_ids: ['invented'] },
    { messageId: 'm', runId: 'demo', taskId: 't', symbol: 'AAPL', thesisId: 'th-1' }, new Set(['obs-1'])), /unknown evidence/);
});
