#!/usr/bin/env node
import assert from 'node:assert/strict';
import { BrowserPage, DashboardTestEnv, delay, waitFor } from './dashboard-test-env.ts';

// Two real browser tabs, isolated coordination DB. Session names are self-declared, as in the CLI.
const environment = await DashboardTestEnv.create('development');
const call = environment.call.bind(environment);
const task = (id: string) => environment.rows('dev_task').find(row => row.id === id)!;
const setInput = async (page: BrowserPage, label: string, value: string) => {
  await page.evaluate(`(() => { const element = Array.from(document.querySelectorAll('[data-field]')).find(el => el.dataset.field === ${JSON.stringify(label)}); element.focus(); element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await delay(80);
};
const taskCard = (id: string) => `Array.from(document.querySelectorAll('.research-card')).find(card => Array.from(card.querySelectorAll('.field-value')).some(el => el.textContent === ${JSON.stringify(id)}))`;
const taskButton = async (page: BrowserPage, id: string, label: string) => {
  await page.evaluate(`(() => { const card = ${taskCard(id)}; if (!card) throw new Error('Task card missing'); card.querySelector('details').open = true; })()`);
  await delay(80);
  await page.evaluate(`(() => { const card = ${taskCard(id)}; const button = Array.from(card.querySelectorAll('button')).find(el => el.textContent === ${JSON.stringify(label)}); if (!button || button.disabled) throw new Error('Task action unavailable'); button.click(); })()`);
};
const navigation = (page: BrowserPage, label: string) => page.evaluate(`Array.from(document.querySelectorAll('.run-item')).find(el => el.textContent === ${JSON.stringify(label)}).click()`);

try {
  call('register', 'fixture-admin', 'human', 'Isolated browser fixture');
  call('register', 'fixture-recipient', 'human', 'Message destination fixture');
  call('create_task', 'fixture-admin', 'dev-race', 'Race to own this task', 'Fixture race', 'fixture/', '');
  call('create_task', 'fixture-admin', 'dev-prerequisite', 'Complete this prerequisite', 'Fixture dependency', 'fixture/', '');
  call('create_task', 'fixture-admin', 'dev-dependent', 'Work after prerequisite', 'Fixture dependency', 'fixture/', 'dev-prerequisite');
  const a = await environment.openPage();
  await a.visible('Development coordination'); await a.visible('fixture-admin'); await a.visible('Race to own this task');
  const b = await environment.openPage();
  await b.visible('Development coordination'); await b.visible('Race to own this task');
  call('create_task', 'fixture-admin', 'dev-live', 'LIVE-INSERTED-TASK', 'Created after subscribing', 'fixture/', '');
  await a.visible('LIVE-INSERTED-TASK'); await b.visible('LIVE-INSERTED-TASK');
  console.log('PASS two real browser tabs receive the initial snapshot and live task inserts');

  await setInput(a, 'Your session name', 'INVALID NAME');
  await setInput(a, 'Message', 'invalid-name-message');
  await a.evaluate("document.querySelector('form').requestSubmit()");
  await a.visible('Choose a lowercase session name');
  assert.equal(environment.rows('dev_message').length, 0);
  const hostile = '<img src=x onerror="window.__hostile=true">DEV-HOSTILE-TEXT';
  await setInput(a, 'Your session name', 'browser-a');
  await setInput(a, 'Recipient (blank = everyone)', 'fixture-recipient');
  await setInput(a, 'Task ID (optional)', 'dev-race');
  await setInput(a, 'Message', hostile);
  await a.evaluate("document.querySelector('form').requestSubmit()");
  await a.visible('DEV-HOSTILE-TEXT'); await b.visible('DEV-HOSTILE-TEXT');
  await waitFor(() => a.evaluate<boolean>("document.querySelector('textarea').value === ''"), 'sent draft cleared');
  const message = environment.rows('dev_message').find(row => row.sender === 'browser-a')!;
  assert.equal(message.body, hostile); assert.equal(message.recipient, 'fixture-recipient'); assert.equal(message.task_id, 'dev-race');
  assert.equal(await a.evaluate<boolean>('window.__hostile === true'), false);
  assert.equal(await a.evaluate<number>("document.querySelectorAll('.timeline img').length"), 0);
  await setInput(b, 'Your session name', 'browser-b');
  await setInput(b, 'Message', 'Second browser registered');
  await b.evaluate("document.querySelector('form').requestSubmit()");
  await a.visible('Second browser registered'); await b.visible('Second browser registered');
  assert.equal(environment.rows('dev_message').find(row => row.sender === 'browser-b')!.recipient, '');
  console.log('PASS invalid-name refusal, register/send, recipient/task routing, draft clearing and escaped hostile text');

  await taskButton(a, 'dev-dependent', 'Claim task');
  await a.visible('waits on dev-prerequisite');
  assert.equal(task('dev-dependent').status, 'open');
  // Capture both buttons before a subscription rerender can remove the losing browser's control.
  for (const page of [a, b]) {
    await page.evaluate(`(() => { const card = ${taskCard('dev-race')}; card.querySelector('details').open = true; window.__raceButton = card.querySelector('button'); })()`);
  }
  await Promise.all([a.evaluate('window.__raceButton.click()'), b.evaluate('window.__raceButton.click()')]);
  await waitFor(() => task('dev-race').status === 'claimed', 'atomic claim');
  const winner = task('dev-race').assignee as string;
  assert.ok(['browser-a', 'browser-b'].includes(winner));
  const owner = winner === 'browser-a' ? a : b;
  const loser = winner === 'browser-a' ? b : a;
  const loserName = winner === 'browser-a' ? 'browser-b' : 'browser-a';
  await loser.visible(`is claimed (${winner})`);
  assert.equal(environment.rows('dev_task').filter(row => row.id === 'dev-race' && row.status === 'claimed').length, 1);
  console.log('PASS incomplete dependencies refuse claims; exactly one competing browser wins');

  call('lock', winner, 'fixture-owned/', 'dev-race', 'Browser task reservation', 10);
  await a.visible('fixture-owned/'); await b.visible('fixture-owned/');
  owner.promptReply = 'BLOCK-FIXTURE-REASON';
  await taskButton(owner, 'dev-race', 'Block');
  await waitFor(() => task('dev-race').status === 'blocked', 'owner blocks task');
  assert.equal(task('dev-race').result, 'BLOCK-FIXTURE-REASON');
  assert.equal(environment.rows('file_lock').length, 1);
  await navigation(owner, 'Blocked'); await owner.visible('BLOCK-FIXTURE-REASON');
  owner.promptReply = 'RELEASE-FIXTURE';
  await taskButton(owner, 'dev-race', 'Release');
  await waitFor(() => task('dev-race').status === 'open', 'owner releases task');
  assert.equal(task('dev-race').assignee, '');
  await a.absent('fixture-owned/'); await b.absent('fixture-owned/');
  await loser.visible('Race to own this task');
  await taskButton(loser, 'dev-race', 'Claim task');
  await waitFor(() => task('dev-race').assignee === loserName, 'released task takeover');
  call('lock', loserName, 'fixture-takeover/', 'dev-race', 'New owner reservation', 10);
  await loser.visible('fixture-takeover/');
  loser.promptReply = 'DONE-FIXTURE';
  await taskButton(loser, 'dev-race', 'Complete');
  await waitFor(() => task('dev-race').status === 'done', 'owner completion');
  assert.equal(task('dev-race').result, 'DONE-FIXTURE');
  assert.equal(environment.rows('file_lock').length, 0);
  await navigation(owner, 'Completed'); await owner.visible('DONE-FIXTURE');
  assert.equal(await owner.evaluate<number>(`${taskCard('dev-race')}.querySelectorAll('button').length`), 0);
  console.log('PASS block/release/takeover/complete, status filtering and live task-lock retention/release');

  await taskButton(loser, 'dev-prerequisite', 'Claim task');
  await waitFor(() => task('dev-prerequisite').status === 'claimed', 'prerequisite claim');
  loser.promptReply = 'PREREQUISITE-DONE';
  await taskButton(loser, 'dev-prerequisite', 'Complete');
  await waitFor(() => task('dev-prerequisite').status === 'done', 'prerequisite completion');
  await taskButton(loser, 'dev-dependent', 'Claim task');
  await waitFor(() => task('dev-dependent').status === 'claimed', 'dependency unlocked');
  assert.equal(task('dev-dependent').assignee, loserName);
  console.log('PASS dependency completion unlocks the next task through the browser');

  const token = await a.evaluate<string>(`localStorage.getItem(${JSON.stringify(environment.tokenKey)})`);
  assert.ok(token);
  const messagesBefore = environment.rows('dev_message').length;
  await a.send('Page.reload'); await a.visible('Development coordination'); await a.visible('LIVE-INSERTED-TASK');
  assert.equal(await a.evaluate<string>(`localStorage.getItem(${JSON.stringify(environment.tokenKey)})`), token);
  await environment.stopDatabase(); await a.visible('Reconnecting'); await b.visible('Reconnecting');
  await environment.startDatabase(); await a.visible('LIVE-INSERTED-TASK'); await b.visible('LIVE-INSERTED-TASK');
  assert.equal(await b.evaluate<string>(`localStorage.getItem(${JSON.stringify(environment.tokenKey)})`), token);
  assert.equal(environment.rows('dev_message').length, messagesBefore);
  assert.equal(task('dev-race').status, 'done');
  assert.equal(task('dev-dependent').status, 'claimed');
  assert.equal(a.exceptions.length + b.exceptions.length, 0, JSON.stringify([...a.exceptions, ...b.exceptions]));
  console.log('PASS reload/restart preserve the identity and task snapshot without replaying messages/actions');
  console.log('[dashboard:development] All browser acceptance checks passed; shared board untouched.');
} finally {
  await environment.dispose();
}
