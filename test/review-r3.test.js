// -----------------------------------------------------------------------------
// Review r3: a start never lets go a stop clicked after it arrived, whether
// the stop cut it on the line or its 2xx came back meanwhile (B3); a kept stop
// stays kept when the start never left, or got a 401 or a 429 (I4); a hung
// /data after the byte of a stop never stops its checks nor the next click.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { ChargerError, ERROR_KINDS } from '../src/warp/http.js';
import { NOW, fakeWarp } from './fixtures/fakeWarp.js';
import { ALLOW, SECOND, ok, refused, setup } from './helpers.js';
import { testClock } from './kit/clock.mjs';

const F = FEATURES;
const STOP = '/evse/stop_charging';
const START = '/evse/start_charging';

/**
 * The PUT of the start answered `answerMs` after its bytes left, and applied
 * by the charger `landsMs` after they left, whatever happens to the answer
 * (cut by the stop or not): a start that lands late.
 */
function startOnTheWire(t, { answerMs, landsMs }) {
  const transport = t.app.client.transport;
  t.app.client.transport = (o) => {
    if (o.method !== 'PUT' || o.path !== START) return transport(o);
    return new Promise((resolve, reject) => {
      try {
        o.beforeSend?.();
      } catch (err) {
        reject(new ChargerError(ERROR_KINDS.YIELDED, err.message, { cause: err }));
        return;
      }
      t.clock.timers.setTimeout(() => (t.dev.slots[4].max_current = 32_000), landsMs);
      const timer = t.clock.timers.setTimeout(
        () => resolve({ status: 200, headers: {}, body: '' }),
        answerMs,
      );
      o.signal?.addEventListener(
        'abort',
        () => {
          t.clock.timers.clearTimeout(timer);
          reject(new ChargerError(ERROR_KINDS.ABORTED, 'Aborted'));
        },
        { once: true },
      );
    });
  };
}

/** Fires Start and waits until its bytes left: `{ ack }` (a promise not awaited here). */
async function startLeft(t) {
  const ack = t.fire(F.START);
  for (let i = 0; i < 400 && !t.app.command?.sent; i += 1) await t.advance(5, 5);
  assert.ok(t.app.command?.sent, 'the start left');
  return { ack };
}

for (const landsMs of [1_500, 25_000]) {
  test(`B3: a stop clicked while a start is on the line cuts it, is kept, and counters it landing ${landsMs / 1000} s later`, async () => {
    const t = await setup({ config: ALLOW });
    t.dev.slots[4].max_current = 0; // stopped: the start writes
    startOnTheWire(t, { answerMs: SECOND, landsMs });
    const { ack: start } = await startLeft(t);
    await t.advance(100, 5);
    const stop = t.fire(F.STOP);
    await t.advance(5 * SECOND, 50);
    ok(await stop);
    refused(await start, /sans confirmation/);
    assert.ok(t.app.stopGuard, 'the stop clicked during the start is kept');
    assert.ok(t.app.stopGuard.watchUntil > t.clock.monotonic(), 'watched for the late start');
    await t.advance(landsMs + 20 * SECOND, 100);
    assert.equal(t.dev.slots[4].max_current, 0, 'the late start is countered');
    assert.ok(t.dev.writesTo(STOP) >= 2, `${t.dev.writesTo(STOP)} stop writes`);
  });
}

test('B3: a start answered 2xx after a stop was clicked (the stop waits for /data) never lets that stop go', async () => {
  const clock = testClock({ start: NOW });
  const store = memoryStore();
  const save = store.save.bind(store);
  store.slow = false;
  // A slow disk: the stop waits 200 ms for /data before it takes the line.
  store.save = (data) =>
    store.slow
      ? new Promise((resolve) => clock.timers.setTimeout(resolve, 300)).then(() => save(data))
      : save(data);
  const t = await setup({ clock, store, config: ALLOW });
  t.dev.slots[4].max_current = 0;
  startOnTheWire(t, { answerMs: 150, landsMs: 1_500 });
  const { ack: start } = await startLeft(t);
  await t.advance(100, 5);
  store.slow = true;
  const stop = t.fire(F.STOP);
  await t.advance(60, 5); // the 2xx of the start is back, the stop still waits for /data
  assert.equal(t.dev.writesTo(STOP), 0, 'the stop has not left yet');
  assert.ok(t.app.stopGuard, 'the stop clicked after the start is not let go by its 2xx');
  await t.advance(5 * SECOND, 50);
  await stop;
  await start;
  assert.ok(t.app.stopGuard, 'kept');
  await t.advance(25 * SECOND, 100);
  assert.equal(t.dev.slots[4].max_current, 0, 'the late start is countered');
  assert.ok(t.dev.writesTo(STOP) >= 2, `${t.dev.writesTo(STOP)} stop writes`);
});

/** A stop sent and kept (the charger does not apply it), then Start answered by `answer`. */
async function keptStopThenStart(answer) {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  const apply = dev.put[STOP];
  dev.put[STOP] = () => {}; // not applied: kept
  const t = await setup({ clock, dev, config: ALLOW });
  refused(await t.press(F.STOP), /pas encore appliqué/);
  assert.ok(t.app.stopGuard, 'kept');
  const stops = dev.writesTo(STOP);
  dev.put[STOP] = apply; // the next one applies
  const transport = t.app.client.transport;
  let tried = 0;
  t.app.client.transport = (o) => {
    if (o.method === 'PUT' && o.path === START) {
      tried += 1;
      return answer(o);
    }
    return transport(o);
  };
  const ack = await t.press(F.START, 1, 500);
  assert.equal(tried, 1, 'the start was tried (written while a stop is kept)');
  assert.equal(dev.writesTo(START), 0);
  assert.ok(t.app.stopGuard, 'the stop is still kept');
  await t.advance(20 * SECOND, 100);
  assert.ok(dev.writesTo(STOP) > stops, 'sent again by the check');
  assert.equal(dev.slots[4].max_current, 0, 'applied');
  return { t, ack };
}

test('I4: a start that never left (unreachable) keeps the stop: sent again at the check', async () => {
  const { ack } = await keptStopThenStart(() =>
    Promise.reject(new ChargerError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED')),
  );
  refused(ack, /Non envoyé/);
});

test('I4: a start answered 401 keeps the stop: sent again at the check', async () => {
  const { ack } = await keptStopThenStart((o) => {
    o.beforeSend?.();
    return Promise.resolve({ status: 401, headers: {}, body: '' });
  });
  refused(ack, /a refusé la commande \(auth\)/);
});

test('I4: a start answered 429 keeps the stop: sent again at the check, in the pause', async () => {
  const { t, ack } = await keptStopThenStart((o) => {
    o.beforeSend?.();
    return Promise.resolve({ status: 429, headers: {}, body: '' });
  });
  refused(ack, /a refusé la commande/);
  assert.ok(t.app.paused, 'the 429 pauses the reads');
});

test('a hung /data after the byte of a stop: the checks go on and the next click leaves', async () => {
  const clock = testClock({ start: NOW });
  const store = memoryStore();
  const save = store.save.bind(store);
  store.hang = false;
  store.save = (data) => (store.hang ? new Promise(() => {}) : save(data));
  const dev = fakeWarp({ timers: clock.timers });
  const apply = dev.put[STOP];
  dev.put[STOP] = () => {}; // not applied: kept, then saved again (hangs)
  const t = await setup({ clock, dev, store, config: ALLOW });
  store.hang = true;
  refused(await t.press(F.STOP), /sans confirmation pour l'instant|pas encore appliqué/);
  assert.equal(t.app.stopWorker, undefined, 'the stop worker is free');
  assert.ok(t.app.stopGuard?.timer, 'the next check is armed');
  dev.put[STOP] = apply;
  await t.advance(16 * SECOND, 100);
  assert.equal(dev.writesTo(STOP), 2, 'sent again by the check');
  assert.equal(dev.slots[4].max_current, 0);
  // Started again from the app of the charger, then a new click: it leaves at once.
  dev.slots[4].max_current = 32_000;
  ok(await t.press(F.STOP));
  assert.equal(dev.writesTo(STOP), 3);
  assert.equal(dev.slots[4].max_current, 0);
});

test('a stop applied 80 s after a start: checked at the end of the 90 s watch, then let go', async () => {
  const t = await setup({ config: ALLOW });
  ok(await t.press(F.STOP));
  ok(await t.press(F.START)); // 5 s ago
  await t.advance(75 * SECOND, 500);
  const stop = t.fire(F.STOP);
  await t.advance(2 * SECOND, 50);
  ok(await stop);
  const guard = t.app.stopGuard;
  assert.ok(guard, 'watched: the start may still land');
  const left = guard.dueAt - t.clock.monotonic();
  assert.ok(left > 5 * SECOND && left < 10 * SECOND, `next check in ${left} ms`);
  await t.advance(10 * SECOND, 100);
  assert.equal(t.app.stopGuard, undefined, 'let go at the end of the watch');
});
