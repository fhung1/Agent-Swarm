import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceLeases, type ResourceLease } from './resource-leases.ts';
const path = 'world/w/entity/1';
const liveLease = (): ResourceLease => ({ path, holder: 'agent', taskId: 'task',
  expiresAt: { microsSinceUnixEpoch: BigInt(Date.now() + 10_000) * 1000n } });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('lost, expired and foreign-task leases cannot be reacquired by renewal', async () => {
  for (const leases of [[], [{ ...liveLease(), holder: 'peer' }], [{ ...liveLease(), taskId: 'other' }],
    [{ ...liveLease(), expiresAt: { microsSinceUnixEpoch: 0n } }]]) {
    let renewals = 0;
    const heartbeat = new ResourceLeases({ sender: 'agent', taskId: 'task', snapshot: () => leases,
      validate: () => {}, renew: async () => { renewals++; }, onLost: () => {} });
    heartbeat.track(path);
    await assert.rejects(heartbeat.refresh(), /Resource lease lost/);
    assert.equal(renewals, 0); heartbeat.stop();
  }
});
test('concurrent refreshes share one renewal and releasing a resource ends renewal', async () => {
  let renewals = 0;
  const heartbeat = new ResourceLeases({ sender: 'agent', taskId: 'task', snapshot: () => [liveLease()],
    validate: () => {}, renew: async () => { renewals++; await delay(20); }, onLost: () => {} });
  heartbeat.track(path);
  await Promise.all([heartbeat.refresh(), heartbeat.refresh(), heartbeat.refresh()]);
  assert.equal(renewals, 1);
  heartbeat.release(path); await heartbeat.refresh(); assert.equal(renewals, 1); heartbeat.stop();
});
test('uncertain renewal is bounded and stops the heartbeat without unhandled errors', async () => {
  let renewals = 0;
  let lost: unknown;
  const heartbeat = new ResourceLeases({ sender: 'agent', taskId: 'task', snapshot: () => [liveLease()],
    validate: () => {}, renew: async () => { renewals++; await new Promise(() => {}); },
    onLost: error => { lost = error; }, intervalMs: 5, timeoutMs: 10 });
  heartbeat.track(path); heartbeat.start();
  await delay(60);
  assert.match(String(lost), /renewal uncertain/); assert.equal(renewals, 1);
  await delay(20); assert.equal(renewals, 1); heartbeat.stop();
});
test('heartbeat checks task ownership before renewing and stop prevents further work', async () => {
  let renewals = 0;
  let lost: unknown;
  const heartbeat = new ResourceLeases({ sender: 'agent', taskId: 'task', snapshot: () => [liveLease()],
    validate: () => { throw Error('Task ownership lost'); }, renew: async () => { renewals++; },
    onLost: error => { lost = error; }, intervalMs: 5 });
  heartbeat.track(path); heartbeat.start(); await delay(30);
  assert.match(String(lost), /Task ownership lost/); assert.equal(renewals, 0);
  heartbeat.stop(); await heartbeat.refresh(); assert.equal(renewals, 0);
});
