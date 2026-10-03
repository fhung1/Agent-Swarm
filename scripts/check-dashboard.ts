#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DashboardTestEnv, stamp, waitFor } from './dashboard-test-env.ts';

// Real Chrome/reducers, synthetic local order ledger, no provider/broker calls.
const environment = await DashboardTestEnv.create('trading');
const call = environment.call.bind(environment);
const role = environment.role.bind(environment);
const cliRun = environment.cliRun.bind(environment);
const { origin, database, publisher } = environment;
try {
  const runId = 'browser-fixture'; const accountId = 'browser-paper'; const symbol = 'QBROWSER';
  const hostile = '<img src=x onerror="window.__hostile=true">HOSTILE-TEXT';
  const sourceId = 'browser-source'; const factId = 'browser-fact'; const unsafeId = 'browser-unsafe-source';
  const thesisId = 'browser-thesis'; const decisionId = 'browser-decision'; const proposalId = 'browser-proposal';
  const policyId = 'browser-policy'; const snapshotId = 'browser-account'; const quoteId = 'browser-quote'; const orderId = 'browser-order';
  const policy = { version: policyId, allowedSymbols: [symbol], longOnly: true, maxOrderNotional: 1000, maxPositionNotional: 5000,
    maxQuoteAgeMs: 120000, maxAccountAgeMs: 120000, maxLimitDeviation: 0.05, approvalTtlMs: 120000, maxProposalAgeMs: 900000,
    requireMarketOpen: true, maxPortfolioNotional: 10000, maxOpenOrders: 5 };
  role('operator');
  call('create_run', runId, 'Synthetic browser acceptance; no broker request');
  call('grant_run_access', publisher.identity, runId);
  call('grant_account_access', publisher.identity, accountId);
  call('add_risk_policy', policyId, runId, accountId, JSON.stringify(policy));
  role('ingestor');
  call('add_source', sourceId, runId, symbol, 'fixture', 'https://example.invalid/filing', stamp(), 'fixture-checksum', 'fixture-only');
  call('add_source', unsafeId, runId, symbol, 'fixture', 'javascript:window.__hostile=true', stamp(), 'fixture-checksum', 'fixture-only');
  call('add_fact', factId, sourceId, symbol, 'Fixture revenue', '123456', 'USD', 'fixture-period', 'synthetic');
  role('analyst');
  call('publish_thesis', thesisId, runId, '', symbol, hostile, 'Fixture counterargument', 'Synthetic assumption', 'Fixture invalidation', `${sourceId},${factId},${unsafeId}`);
  role('market_data');
  call('record_account_snapshot', snapshotId, accountId, 'ACTIVE', '12345.67', '12345.67', '20000', '[]', '[]',
    [{ id: quoteId, symbol, feed: 'iex', bid_price: '99', ask_price: '100', bid_size: '1', ask_size: '1', as_of: stamp() }]);
  const clock = stamp(); call('record_market_clock', accountId, true, clock);
  role('coordinator');
  call('post_message', 'browser-critique', runId, '', symbol, 'coordinator', 'challenge', 'Synthetic skeptic objection', thesisId);
  call('record_decision_input', decisionId, runId, thesisId, quoteId, 'browser-critique', 'fixture-model', 'fixture-v1', policyId, '1000');
  call('record_decision', decisionId, thesisId, 'trade', 'Synthetic traceable decision; no real trade');
  call('propose_trade', proposalId, runId, thesisId, symbol, 'buy', '2', 'market', '');
  role('risk');
  call('record_risk_decision', 'browser-risk', proposalId, policyId, 'pass', '', stamp(90_000), snapshotId, clock);
  role('operator');

  const page = await environment.openPage();
  const evaluate = page.evaluate.bind(page);
  const send = page.send.bind(page);
  const visible = page.visible.bind(page);
  const absent = page.absent.bind(page);
  const orderStatus = (status: string) => waitFor(() => evaluate<boolean>(
    `Array.from(document.querySelectorAll('.order-detail .field-value')).some(element => element.textContent === ${JSON.stringify(`${status} · browser-client-order`)})`,
  ), `exact order status ${status}`);
  await visible('Waiting for an operator grant');
  const browserIdentity = await evaluate<string>("document.querySelector('.gate-card .field-value').textContent");
  assert.match(browserIdentity, /^[a-f0-9]{64}$/);
  assert.equal(await evaluate<number>("document.querySelectorAll('.run-item,.account-grid,.research-card,.order-detail').length"), 0);
  await absent(runId); await absent('12345.67');
  console.log('PASS fresh ungranted browser sees no run, evidence, account or order rows');
  call('grant_agent', browserIdentity, 'operator');
  await visible(runId); await visible('No account snapshot is visible'); await absent('12345.67');
  call('grant_account_access', browserIdentity, accountId);
  await visible('12345.67'); await visible('Fixture counterargument'); await visible('Synthetic traceable decision');
  await visible('Frozen inputs'); await visible('fixture-model'); await visible('browser-policy');
  await evaluate("document.querySelector('.evidence-details').open = true");
  await visible('Fixture revenue: 123456 USD');
  assert.equal(await evaluate<string>("document.querySelector('a.evidence-link').getAttribute('href')"), 'https://example.invalid/filing');
  assert.equal(await evaluate<number>("document.querySelectorAll('a[href^=\"javascript:\"],.case img').length"), 0);
  assert.equal(await evaluate<boolean>('window.__hostile === true'), false);
  await visible(hostile); await visible('PASS');
  console.log('PASS live grants, source/fact/decision/frozen-input/risk trace and safe hostile text/URL rendering');

  call('create_task', 'browser-live-task', runId, symbol, 'research', 'LIVE-TASK-OBJECTIVE', 'analyst', '');
  call('post_message', 'browser-live-message', runId, 'browser-live-task', symbol, '', 'observation', `LIVE-MESSAGE ${hostile}`, sourceId);
  await visible('LIVE-TASK-OBJECTIVE'); await visible('LIVE-MESSAGE');
  role('executor');
  call('reserve_paper_order', orderId, proposalId, 'browser-client-order');
  await orderStatus('submitting');
  call('update_paper_order', orderId, 'fixture-broker-id', 'accepted');
  await orderStatus('accepted');
  assert.equal(await evaluate<number>("[...document.querySelectorAll('.order-detail .field-label')].filter(el=>el.textContent==='Fill').length"), 0);
  call('record_fill', 'browser-fill-one', orderId, 'fixture-activity-one', '1', '100', stamp());
  call('update_paper_order', orderId, 'fixture-broker-id', 'partially_filled');
  await orderStatus('partially_filled'); await visible('fixture-activity-one');
  call('record_fill', 'browser-fill-two', orderId, 'fixture-activity-two', '1', '100', stamp());
  call('update_paper_order', orderId, 'fixture-broker-id', 'filled');
  await orderStatus('filled'); await visible('fixture-activity-two');
  role('operator');
  console.log('PASS live task/message/order/partial-fill/fill updates; accepted order has no fill');

  await evaluate("[...document.querySelectorAll('button')].find(el=>el.textContent==='Pause run').click()");
  await visible('Resume run');
  assert.match(cliRun(['sql', '--server', origin, database, `SELECT status FROM run WHERE id = '${runId}'`], 'paused reducer state'), /paused/);
  await evaluate("[...document.querySelectorAll('button')].find(el=>el.textContent==='Resume run').click()");
  await visible('Pause run');
  assert.match(cliRun(['sql', '--server', origin, database, `SELECT status FROM run WHERE id = '${runId}'`], 'active reducer state'), /active/);
  assert.equal(await evaluate<boolean>("[...document.querySelectorAll('button')].find(el=>el.textContent==='Cancel order').disabled"), true);
  console.log('PASS pause/resume reducers commit; cancellation remains disabled pending its workflow');
  const tokenKey = environment.tokenKey;
  const token = await evaluate<string>(`localStorage.getItem(${JSON.stringify(tokenKey)})`);
  assert.ok(token);
  await send('Page.reload'); await visible('fixture-activity-two');
  assert.equal(await evaluate<string>(`localStorage.getItem(${JSON.stringify(tokenKey)})`), token);
  await environment.stopDatabase(); await visible('Reconnecting');
  await environment.startDatabase(); await visible('fixture-activity-two');
  assert.equal(await evaluate<string>(`localStorage.getItem(${JSON.stringify(tokenKey)})`), token);
  console.log('PASS reload and actual server disconnect/restart retain identity and restore subscribed rows');
  call('revoke_account_access', browserIdentity, accountId);
  await absent('12345.67'); await absent('fixture-broker-id'); await absent('fixture-activity-one');
  await visible('No account snapshot is visible');
  call('revoke_agent', browserIdentity);
  await visible('Waiting for an operator grant');
  await absent(runId); await absent('LIVE-MESSAGE'); await absent('Fixture counterargument');
  assert.equal(await evaluate<number>("document.querySelectorAll('.run-item,.account-grid,.research-card,.order-detail').length"), 0);
  assert.equal(page.exceptions.length, 0, `Browser runtime exceptions: ${JSON.stringify(page.exceptions)}`);
  console.log('PASS live account and operator revocation remove protected rows; no runtime exceptions');
  console.log('[dashboard] All browser acceptance checks passed (synthetic local ledger, no Alpaca/model calls).');
} finally {
  await environment.dispose();
}
