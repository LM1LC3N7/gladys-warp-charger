// -----------------------------------------------------------------------------
// The guard of gladys-p1-monitor, taken as is (pure): never 0, drops and
// jumps held whatever the time, the acceptance bounded to what was shown.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexGuard } from '../src/guard.js';

const H = 3_600_000;

test('never 0; a plausible rise taken; a drop and a jump held, never by time', () => {
  const g = new IndexGuard({ value: 100, at: 0 }, undefined, 0);
  assert.equal(g.accept(0, 1000), false);
  assert.equal(g.accept(101, H), true);
  assert.equal(g.accept(50, H + 1000), false);
  assert.equal(g.held.direction, 'down');
  for (let i = 2; i < 50; i += 1) assert.equal(g.accept(50, i * H), false);
  const j = new IndexGuard({ value: 100, at: 0 }, undefined, 0);
  assert.equal(j.accept(1000, 60_000), false, '900 kWh in a minute');
  assert.equal(j.accept(1000, 100 * H), false, 'still held days later');
});

test('the acceptance takes what was shown plus the margin since, nothing else', () => {
  const g = new IndexGuard({ value: 100, at: 0 }, undefined, 0);
  g.accept(5000, 60_000);
  const taken = g.acceptHeld();
  assert.deepEqual(taken, { direction: 'up', from: 100, to: 5000 });
  assert.equal(g.accept(9000, 120_000), false, 'beyond what was accepted');
  assert.equal(g.held.to, 9000);
  g.acceptHeld();
  assert.equal(g.accept(9000.1, 130_000), true);
});

test('the state for /data: the reference and the value held, never the acceptance', () => {
  const g = new IndexGuard({ value: 100, at: 0 }, undefined, 0);
  g.accept(3, 1000);
  g.acceptHeld();
  const kept = new IndexGuard(undefined, g.state(), 5000);
  assert.equal(kept.held.to, 3);
  assert.equal(kept.held.at, 5000, 'dated when loaded');
  assert.equal(kept.accepted, undefined);
});

test('a first value of 0 is never taken as the reference', () => {
  const g = new IndexGuard(undefined, undefined, 0);
  assert.equal(g.accept(0, 1000), false);
  assert.equal(g.last, undefined);
});
