import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyDatabase, selectRun } from './store.js';

const now = 100_000;
function databaseWithWorker(status = 'online', lastSeen = now) {
  return { ...emptyDatabase(), agents: [{ identity: 'worker', name: 'Analyst', role: 'analyst', status, lastSeen }] };
}

test('a worker is visible before any run, task, or message exists', () => {
  const state = selectRun(databaseWithWorker(), '', true, now);
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].online, true);
  assert.equal(state.agents[0].participating, false);
});

test('a role grant alone does not imply a live worker', () => {
  assert.equal(selectRun(databaseWithWorker('offline'), '', true, now).agents[0].online, false);
});

test('presence expires and is unavailable during a database outage', () => {
  assert.equal(selectRun(databaseWithWorker('online', now - 45_000), '', true, now).agents[0].online, false);
  assert.equal(selectRun(databaseWithWorker(), '', false, now).agents[0].online, false);
  const database = databaseWithWorker();
  database.agents[0].role = 'revoked';
  assert.equal(selectRun(database, '', true, now).agents[0].online, false);
});

test('worker presence spans runs while tasks and participation remain scoped', () => {
  const database = databaseWithWorker();
  database.tasks.push({ id: 'task', runId: 'first', objective: 'Research', status: 'claimed', result: '', assignee: 'worker' });
  assert.equal(selectRun(database, 'first', true, now).agents[0].participating, true);
  const other = selectRun(database, 'second', true, now);
  assert.equal(other.agents[0].online, true);
  assert.equal(other.agents[0].participating, false);
  assert.deepEqual(other.tasks, []);
});
