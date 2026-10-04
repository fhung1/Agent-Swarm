import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ask } from '../agents/llm.ts';
import { buildFactorioPrompt, decideFactorio, selectPeerMessages, validateFactorioDecision, type FactorioContext } from './inference.ts';

const context: FactorioContext = { runId: 'run', worldId: 'world', historyId: 'history', actorId: 7, sender: 'agent-7',
  objective: 'Produce five plates', operatorPrompt: 'Cooperate', observation: { inventory: {}, nearby: [] }, status: { paused: false }, reservations: [], messages: [], lastResult: null };
const wait = { kind: 'wait', command: null, message: 'Waiting for peer', recipient: '', waitMs: 500 };
test('strict decisions reject unsupported commands and inconsistent fields', () => {
  assert.deepEqual(validateFactorioDecision(wait), wait);
  assert.throws(() => validateFactorioDecision({ ...wait, command: { kind: 'move', x: 0, y: 0, maxTicks: 10 } }));
  assert.throws(() => validateFactorioDecision({ ...wait, waitMs: 0 }));
  assert.throws(() => validateFactorioDecision({ ...wait, kind: 'complete', waitMs: 0, recipient: 'peer' }));
  const action = { ...wait, kind: 'action', waitMs: 0, command: { kind: 'take', targetId: 1, item: 'iron-ore', quantity: 21 } };
  assert.throws(() => validateFactorioDecision(action));
  assert.throws(() => validateFactorioDecision({ ...action, command: { kind: 'shell', command: 'ls' } }));
  assert.throws(() => validateFactorioDecision({ ...wait, message: 'x'.repeat(2001) }));
  assert.throws(() => validateFactorioDecision({ ...wait, extra: true }));
});
test('peer messages are scoped by run, world, history and recipient and sorted numerically', () => {
  const row = (id: string, patch = {}, recipient = '') => ({ id, sender: 'peer', recipient,
    body: JSON.stringify({ version: 1, runId: 'run', worldId: 'world', historyId: 'history', sender: 'peer', kind: 'chat', payload: { text: 'Furnace free' }, ...patch }) });
  const selected = selectPeerMessages([row('10'), row('2'), row('3', { runId: 'other' }), row('4', { historyId: 'other' }), row('5', {}, 'elsewhere'), row('6', {}, 'agent-7'), row('7', { sender: 'spoof' }), row('8', { worldId: 'other' })], context);
  assert.deepEqual(selected.map(m => m.id), ['2', '6', '10']);
});
test('prompt keeps bounded recent chat and reports omissions; required context cannot be dropped', () => {
  const messages = Array.from({ length: 100 }, (_, i) => ({ id: String(i), sender: 'peer', recipient: '', kind: 'chat', payload: 'x'.repeat(2500) }));
  const prompt = buildFactorioPrompt({ ...context, messages });
  const data = JSON.parse(prompt);
  assert.ok(prompt.length < 32000);
  assert.equal(data.messages.at(-1).id, '99');
  assert.equal(data.omittedMessages, 100 - data.messages.length);
  assert.equal(data.actorId, 7);
  assert.throws(() => buildFactorioPrompt({ ...context, observation: 'x'.repeat(24000) }));
});
test('inference consumes observation and peer context with structured output', async () => {
  let seen = '';
  const ask = (async (_schema, _system, prompt) => { seen = prompt; return wait; }) as Ask;
  const decision = await decideFactorio(ask, context);
  assert.equal(decision.kind, 'wait');
  assert.equal(JSON.parse(seen).actorId, 7);
});
test('invalid provider output is rejected without scripted fallback', async () => {
  const ask = (async () => ({ ...wait, kind: 'action' })) as Ask;
  await assert.rejects(decideFactorio(ask, context), /requires command/);
});
test('abort ends inference even if a provider ignores cancellation', async () => {
  const controller = new AbortController();
  const ask = (() => new Promise(() => {})) as Ask;
  const decision = decideFactorio(ask, context, { signal: controller.signal });
  controller.abort(new Error('Operator stopped'));
  await assert.rejects(decision, /Operator stopped/);
  await assert.rejects(decideFactorio(ask, context, { signal: controller.signal }), /Operator stopped/);
});
