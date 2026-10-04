import test from 'node:test';
import assert from 'node:assert/strict';
import { readinessStatus, releaseStatus } from './application-readiness.ts';

test('readiness reports missing implementation as blocked', () => {
  assert.equal(readinessStatus({ implemented: false }), 'blocked');
});

test('readiness distinguishes implementation from a fixture run', () => {
  assert.equal(readinessStatus({ implemented: true }), 'implemented');
  assert.equal(readinessStatus({ implemented: true, fixtureVerified: true }), 'fixture-verified');
});

test('live evidence outranks fixture evidence', () => {
  assert.equal(readinessStatus({ implemented: true, fixtureVerified: true, liveVerified: true }), 'live-verified');
});

test('release stays blocked if any required live gate is missing', () => {
  assert.equal(releaseStatus(['live-verified', 'blocked']), 'blocked');
  assert.equal(releaseStatus(['live-verified', 'fixture-verified']), 'blocked');
});

test('release becomes live-verified only when every required gate is live-verified', () => {
  assert.equal(releaseStatus(['live-verified', 'live-verified']), 'live-verified');
  assert.equal(releaseStatus([]), 'blocked');
});
