// -----------------------------------------------------------------------------
// The line (pure): one holder at a time, in priority order; a stop aborts
// whatever holds it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lane } from '../src/lane.js';

test('one holder; the stop first; a stop aborts the holder; a wait given up', async () => {
  const lane = new Lane();
  const read = await lane.acquire('read');
  const order = [];
  const command = lane.acquire('command').then((h) => (order.push('command'), h));
  const check = lane.acquire('check').then((h) => (order.push('check'), h));
  assert.equal(read.signal.aborted, false);
  const stop = lane.acquire('stop').then((h) => (order.push('stop'), h));
  assert.equal(read.signal.aborted, true, 'the stop aborts the holder');
  read.release();
  (await stop).release();
  (await command).release();
  (await check).release();
  assert.deepEqual(order, ['stop', 'command', 'check']);
  const holder = await lane.acquire('read');
  const giveUp = new AbortController();
  const waiting = lane.acquire('command', { signal: giveUp.signal });
  giveUp.abort();
  await assert.rejects(waiting);
  holder.release();
  assert.equal(lane.holder, undefined);
});
