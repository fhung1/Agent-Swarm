import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ask } from '../agents/llm.ts';
import type { BoardSnapshot } from '../../message-board/client.ts';
import { runFactorioOrchestrator, selectRunMessages, validateOrchestratorDecision } from './orchestrator.ts';

const runId = 'run';
const worldId = 'world';
const historyId = 'history';
const sender = `${runId}-orchestrator`;
const agents = Array.from({ length: 5 }, (_, i) => `${runId}-agent-${i + 1}`);
function fixture() {
  const goal = { id: `${runId}.goal-rocket`, title: 'Beat Factorio: launch a rocket', details: 'push when finished', status: 'open', assignee: '' };
  const worker = { id: `${runId}.production-1`, title: 'Gather for the rocket', details: '', status: 'claimed', assignee: agents[0]!, dependsOn: '' };
  const tasks = [goal, worker] as unknown as BoardSnapshot['tasks'];
  const messages: BoardSnapshot['messages'] = [];
  const created: unknown[] = [];
  const posted: { body: string; recipient: string; taskId: string }[] = [];
  const board = {
    ready: true,
    snapshot: () => ({ tasks, participants: [], messages, reservations: [] }) as unknown as BoardSnapshot,
    register: async () => {},
    claimTask: async (_name: string, id: string) => { const task = tasks.find(row => row.id === id)!; Object.assign(task, { status: 'claimed', assignee: sender }); },
    createTask: async (_name: string, task: unknown) => { created.push(task); tasks.push(task as BoardSnapshot['tasks'][number]); },
    updateTask: async (_name: string, id: string, status: string) => { Object.assign(tasks.find(row => row.id === id)!, { status }); },
    post: async (_name: string, body: string, recipient = '', taskId = '') => {
      const row = { body, recipient, taskId }; posted.push(row);
      messages.push({ id: BigInt(messages.length + 1), sender, recipient, taskId, body,
        createdAt: {} as BoardSnapshot['messages'][number]['createdAt'] });
      if (JSON.parse(body).kind === 'chat') {
        Object.assign(worker, { status: 'done', result: 'Engine launch receipt verified' });
        const actor = agents[0]!;
        messages.push({ id: BigInt(messages.length + 1), sender: actor, recipient: '', taskId: worker.id,
          body: JSON.stringify({ version: 1, runId, worldId, historyId, sender: actor, kind: 'completion',
            payload: { taskId: worker.id, rocketLaunches: 1, tick: 123 } }),
          createdAt: {} as BoardSnapshot['messages'][number]['createdAt'] });
      }
    },
  };
  const state = { calls: 0 };
  const options = {
    scope: { runId, worldId, historyId, sender, agents }, goalTaskId: goal.id,
    objective: 'Launch a rocket', maxCalls: 2, deadline: Date.now() + 10000, intervalMs: 1000, timeoutMs: 1000,
    board, state, save: () => {}, sleep: async () => {},
    ask: (async () => ({ kind: 'direct', recipient: agents[0]!, message: 'Mine iron and report the deposit.' })) as Ask,
  };
  return { options, tasks, messages, created, posted, state, worker, goal };
}

test('board orchestrator directs a player agent and closes the goal only on worker completion', async () => {
  const f = fixture(); let prompt = '';
  f.options.ask = (async (_schema, system, input) => {
    assert.match(system, /no game character/);
    prompt = input;
    return { kind: 'direct', recipient: agents[0]!, message: 'Mine iron and report the deposit.', title: '', details: '', dependsOn: '' };
  }) as Ask;
  await runFactorioOrchestrator(f.options);
  assert.equal(JSON.parse(prompt).agents.length, 5);
  assert.deepEqual(f.posted.map(row => row.recipient), ['', agents[0], '']);
  assert.ok(f.posted.every(row => row.taskId === f.goal.id));
  assert.equal(f.goal.status, 'done');
  assert.equal(f.state.calls, 1);
});

test('board orchestrator creates a run-scoped subtask without a game-action API', async () => {
  const f = fixture();
  f.options.maxCalls = 1;
  f.options.ask = (async () => ({ kind: 'subtask', title: 'Build a shared chest', details: 'Gather wood and place a chest.', dependsOn: '', recipient: agents[1]!, message: '' })) as Ask;
  await assert.rejects(runFactorioOrchestrator(f.options), /call limit exhausted/);
  assert.equal((f.created[0] as { id: string }).id, 'run.subtask-orchestrator-1');
  assert.equal((f.created[0] as { area: string }).area, 'factorio-orchestration');
  assert.equal(f.posted.at(-1)?.recipient, agents[1]);
  assert.equal('game' in f.options, false);
});

test('orchestrator decisions cannot direct unknown agents or foreign dependencies', () => {
  const tasks = [{ id: 'run.subtask-one' }];
  assert.throws(() => validateOrchestratorDecision({ kind: 'direct', recipient: 'other-run-agent-1', message: 'Mine', title: '', details: '', dependsOn: '' }, agents, tasks));
  assert.throws(() => validateOrchestratorDecision({ kind: 'subtask', title: 'Help', details: 'Gather wood', dependsOn: 'other-run.task', recipient: '', message: '' }, agents, tasks));
});

test('orchestrator only consumes protocol messages from the same run and history', () => {
  const row = (id: number, senderName: string, run: string, history: string) => ({ id: BigInt(id), sender: senderName, recipient: '', taskId: '',
    body: JSON.stringify({ version: 1, runId: run, worldId, historyId: history, sender: senderName, kind: 'chat', payload: { text: 'hello' } }),
    createdAt: {} as BoardSnapshot['messages'][number]['createdAt'] });
  const selected = selectRunMessages([row(1, agents[0]!, runId, historyId), row(2, agents[1]!, 'elsewhere', historyId), row(3, agents[2]!, runId, 'old-history')],
    { runId, worldId, historyId, sender, agents });
  assert.deepEqual(selected.map(message => message.id), ['1']);
});
