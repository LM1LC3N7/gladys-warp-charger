// -----------------------------------------------------------------------------
// Review r1: a hung /data never holds the stop back (B1), every check of the
// stop arms the next one (B2), a restart keeps the hold of a stop (I1), the
// guards of the stop under test (I2), a drop accepted is the floor (M1), a
// refused start never lets the stop go (M2), the start ceiling on the fixed
// slots (M3).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, FEATURES } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { HOST, NOW, fakeWarp } from './fixtures/fakeWarp.js';
import { ALLOW, CFG, DEVICE, MINUTE, SECOND, ok, refused, setup } from './helpers.js';
import { testClock } from './kit/clock.mjs';

const F = FEATURES;
const STOP = '/evse/stop_charging';
const START = '/evse/start_charging';

/** A store whose save never returns once `hang` is set (a stuck SD card). */
function hangingStore(initial = null) {
  const store = memoryStore(initial);
  const save = store.save.bind(store);
  store.hang = false;
  store.save = (data) => (store.hang ? new Promise(() => {}) : save(data));
  return store;
}

/** Monotonic time of each PUT of the stop that reached the charger. */
function stopTimes(t) {
  const times = [];
  const apply = t.dev.put[STOP];
  t.dev.put[STOP] = (body) => {
    times.push(t.clock.monotonic());
    apply(body);
  };
  return times;
}

test('B1: a stop clicked while a current increase waits on a hung /data leaves within 300 ms', async () => {
  const store = hangingStore();
  const t = await setup({ store, config: { ...ALLOW, max_current: 32 } });
  const times = stopTimes(t);
  store.hang = true;
  const command = t.fire(F.SET_CURRENT, '20');
  await t.advance(400, 5);
  const clicked = t.clock.monotonic();
  const stop = t.fire(F.STOP);
  await t.advance(5 * SECOND, 5);
  assert.equal(times.length, 1);
  assert.ok(times[0] - clicked < 300, `${times[0] - clicked} ms`);
  refused(await command, /arrêt a été cliqué entre-temps|rien envoyé/);
  assert.equal(t.dev.writesTo('/evse/global_current'), 0);
  await stop;
});

test('B1: a 429 on the fresh read of a command with a hung /data never holds the stop back', async () => {
  const store = hangingStore();
  const t = await setup({ store, config: ALLOW });
  const times = stopTimes(t);
  store.hang = true;
  t.dev.status['/evse/slots'] = 429;
  const command = t.fire(F.SET_CURRENT, '10');
  await t.advance(100, 5);
  delete t.dev.status['/evse/slots'];
  const clicked = t.clock.monotonic();
  t.fire(F.STOP);
  await t.advance(2 * SECOND, 5);
  assert.equal(times.length, 1);
  assert.ok(times[0] - clicked < 300);
  await command;
});

test('I2: the stop waits at most 200 ms for /data before its byte', async () => {
  const store = hangingStore();
  const t = await setup({ store });
  const times = stopTimes(t);
  store.hang = true;
  const clicked = t.clock.monotonic();
  t.fire(F.STOP);
  await t.advance(SECOND, 5);
  assert.equal(times.length, 1);
  assert.ok(times[0] - clicked >= 200 && times[0] - clicked < 260, `${times[0] - clicked} ms`);
});

test('I2: a stop answered 429 is tried again within its 3 s', async () => {
  const t = await setup();
  const transport = t.dev.transport;
  let first = true;
  t.app.client.transport = (o) => {
    if (o.method === 'PUT' && first) {
      first = false;
      o.beforeSend?.();
      return Promise.resolve({ status: 429, headers: {}, body: '' });
    }
    return transport(o);
  };
  ok(await t.press(F.STOP));
  assert.equal(t.dev.writesTo(STOP), 1);
  assert.equal(t.dev.slots[4].max_current, 0);
});

test('I2: the stop answers by 4.3 s on a charger that never answers', async () => {
  const t = await setup();
  t.dev.silent.add(STOP);
  const clicked = t.clock.monotonic();
  let at;
  const ack = t.fire(F.STOP).then((a) => ((at = t.clock.monotonic()), a));
  await t.advance(6 * SECOND, 10);
  refused(await ack, /sans confirmation|pas pu partir/);
  assert.ok(at - clicked <= 4_310, `${at - clicked} ms`);
});

test('B2: a stop kept with a 429 pause after a restart is still checked and sent again every 15 s', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  dev.put[STOP] = () => {}; // acked, never applied
  const store = memoryStore({
    target: { host: HOST, port: 80, uid: 'Xy7Kq' },
    lastAttemptAt: NOW - 5 * SECOND,
    pause: { until: NOW + 6 * 60 * MINUTE, reason: '429' },
    stop: { host: HOST, port: 80, since: NOW - MINUTE, written: false, resends: 0 },
  });
  const t = await setup({ clock, dev, store, boot: true, create: false });
  await t.advance(MINUTE + 10 * SECOND, 100);
  assert.equal(t.dev.count('PUT', STOP), 4, 'the boot send and 3 resends, in the pause');
  assert.match(t.status().text, /envoyé 4 fois/);
});

test('B2: a late start landing after the first check of a stop is countered at the next one', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  const t = await setup({ clock, dev, config: { ...ALLOW, poll_interval: 600 } });
  ok(await t.press(F.STOP));
  dev.put[START] = () => {
    clock.timers.setTimeout(() => (dev.slots[4].max_current = 32_000), 30 * SECOND);
  };
  const start = t.fire(F.START);
  await t.advance(700, 10);
  ok(await t.press(F.STOP, 1, 1500));
  await start;
  const writes = dev.writesTo(STOP);
  let landed;
  for (let i = 0; i < 600 && landed === undefined; i += 1) {
    await t.advance(100, 100);
    if (dev.slots[4].max_current === 32_000) landed = t.clock.monotonic();
  }
  assert.ok(landed, 'the late start landed');
  for (let i = 0; i < 160 && dev.slots[4].max_current !== 0; i += 1) await t.advance(100, 100);
  assert.equal(dev.slots[4].max_current, 0, 'countered');
  assert.ok(t.clock.monotonic() - landed <= 15_500, 'within 15 s, not at the next read (600 s)');
  assert.ok(dev.writesTo(STOP) > writes);
});

test('I1: a restart never sends again a stop held after 4 sends; a stop not held is sent and counted', async () => {
  const held = memoryStore({
    target: { host: HOST, port: 80, uid: 'Xy7Kq' },
    stop: { host: HOST, port: 80, since: NOW - MINUTE, written: true, resends: 3 },
  });
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  dev.put[STOP] = () => {};
  const t = await setup({ clock, dev, store: held, boot: true, create: false });
  await t.advance(2 * MINUTE, 200);
  assert.equal(t.dev.count('PUT', STOP), 0);
  assert.ok(t.app.stopGuard, 'still kept and checked');
  assert.equal(held.data.stop.resends, 3);

  const kept = memoryStore({
    target: { host: HOST, port: 80, uid: 'Xy7Kq' },
    stop: { host: HOST, port: 80, since: NOW - MINUTE, written: true, resends: 1 },
  });
  const clock2 = testClock({ start: NOW });
  const dev2 = fakeWarp({ timers: clock2.timers });
  dev2.put[STOP] = () => {};
  const t2 = await setup({ clock: clock2, dev: dev2, store: kept, boot: true, create: false });
  await t2.advance(2 * MINUTE, 200);
  assert.equal(t2.dev.count('PUT', STOP), 2, 'the boot send counted, then one resend left');
  assert.equal(kept.data.stop.resends, 3);
});

test('M1: a drop accepted is the new floor: a lower value is held again', async () => {
  const t = await setup();
  const indexes = () =>
    t.gladys.fake.states
      .filter((s) => s.device_feature_external_id === `${DEVICE}:${F.TOTAL_ENERGY}`)
      .map((s) => s.state);
  t.dev.energy = 10;
  await t.advance(31 * SECOND, 100);
  await t.gladys.fake.action(ACTIONS.ACCEPT_HELD_INDEX);
  await t.advance(4 * SECOND, 100);
  await t.gladys.fake.action(ACTIONS.ACCEPT_HELD_INDEX);
  await t.advance(31 * SECOND, 100);
  assert.equal(indexes().at(-1), 10);
  t.dev.energy = 9.8;
  await t.advance(31 * SECOND, 100);
  assert.ok(!indexes().includes(9.8));
  assert.match(t.status().text, /baisse de 10 à 9,8 kWh/);
});

test('M2: a start refused by the charger never lets the stop go', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  dev.put[STOP] = () => {};
  const t = await setup({ clock, dev, config: ALLOW });
  refused(await t.press(F.STOP), /pas encore appliqué/);
  dev.slots[4].max_current = 0; // the start has something to do
  dev.put[STOP] = () => {};
  const transport = t.dev.transport;
  t.app.client.transport = (o) => {
    if (o.method === 'PUT' && o.path === START) {
      o.beforeSend?.();
      return Promise.resolve({ status: 400, headers: {}, body: '' });
    }
    return transport(o);
  };
  // The read shows slot 4 at 0: that read lets the stop go as applied; set it back to see M2.
  t.app.decideStop = () => 'resend';
  refused(await t.press(F.START), /a refusé la commande/);
  assert.ok(t.app.stopGuard, 'still kept');
});

test('M3: a start is refused on the fixed settings, whatever a dynamic slot says now', async () => {
  const t = await setup({ config: ALLOW });
  ok(await t.press(F.STOP));
  t.dev.slots[5].max_current = 32_000;
  t.dev.slots[7] = { max_current: 6_000, active: true, clear_on_disconnect: true };
  refused(await t.press(F.START), /32 A, au-dessus du plafond de 16 A/);
  assert.equal(t.dev.writesTo(START), 0);
});

test('M5: a cable slot that cannot be read refuses the current (never the ceiling alone)', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.slots[1] = { max_current: 3_000, active: true };
  refused(await t.press(F.SET_CURRENT, '10'), /valeur dont cette commande a besoin/);
});

test('a test of the connection that succeeds sends a kept stop at once', async () => {
  const t = await setup({ config: { ...CFG, poll_interval: 600 } });
  t.dev.down = 'unreachable';
  refused(await t.press(F.STOP, 1, 4500), /pas pu partir/);
  t.dev.down = false;
  await t.advance(SECOND, 100);
  t.gladys.fake.action(ACTIONS.TEST_CONNECTION);
  await t.advance(2 * SECOND, 50);
  assert.equal(t.dev.slots[4].max_current, 0, 'before the 15 s check');
});

test('I2: the answer of the stop by 4.3 s even when the charger answers it slowly', async () => {
  const t = await setup();
  // The stop acked at 2.95 s, its read back slow: the job itself ends after 4.3 s.
  t.dev.latencyMs = (path) => (path === STOP ? 2_950 : path === '/evse/state' ? 700 : 5);
  t.dev.silent.add('/evse/slots');
  const clicked = t.clock.monotonic();
  let at;
  const ack = t.fire(F.STOP).then((a) => ((at = t.clock.monotonic()), a));
  await t.advance(8 * SECOND, 10);
  refused(await ack, /sans confirmation/);
  assert.ok(at - clicked <= 4_310, `${at - clicked} ms`);
});

test('a stop refused (401) is not waited for: no sentAt kept', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers, auth: { user: 'u', password: 'p' } });
  const t = await setup({ clock, dev, config: { ...CFG, username: 'u', password: 'wrong' } });
  refused(await t.press(F.STOP), /refusé l'arrêt/);
  assert.equal(t.app.stopGuard.sentAt, undefined);
});

test('a stop never written is sent at the restart even with 3 resends in /data', async () => {
  const store = memoryStore({
    target: { host: HOST, port: 80, uid: 'Xy7Kq' },
    stop: { host: HOST, port: 80, since: NOW - MINUTE, written: false, resends: 3 },
  });
  const t = await setup({ store, boot: true, create: false });
  await t.advance(2 * SECOND, 50);
  assert.equal(t.dev.writesTo(STOP), 1);
  assert.equal(t.dev.slots[4].max_current, 0);
});

test('a stop that first left on a check still watches for a start sent just before', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  const t = await setup({ clock, dev, config: { ...ALLOW, poll_interval: 600 } });
  ok(await t.press(F.STOP));
  dev.put[START] = () => {
    clock.timers.setTimeout(() => (dev.slots[4].max_current = 32_000), 40 * SECOND);
  };
  refused(await t.press(F.START, 1, 1500), /pas encore appliquée/);
  dev.down = 'unreachable';
  refused(await t.press(F.STOP, 1, 4500), /pas pu partir/);
  dev.down = false;
  await t.advance(20 * SECOND, 100); // the check sends it: its first byte
  assert.equal(dev.slots[4].max_current, 0);
  await t.advance(40 * SECOND, 100); // the late start lands, then is countered
  assert.equal(dev.slots[4].max_current, 0);
});

test('M1: a value under the drop accepted, read right after the acceptance, is held', async () => {
  const t = await setup();
  const indexes = () =>
    t.gladys.fake.states
      .filter((s) => s.device_feature_external_id === `${DEVICE}:${F.TOTAL_ENERGY}`)
      .map((s) => s.state);
  t.dev.energy = 10;
  await t.advance(31 * SECOND, 100);
  await t.gladys.fake.action(ACTIONS.ACCEPT_HELD_INDEX);
  await t.advance(4 * SECOND, 100);
  await t.gladys.fake.action(ACTIONS.ACCEPT_HELD_INDEX);
  t.dev.energy = 9.8;
  await t.advance(31 * SECOND, 100);
  assert.ok(!indexes().includes(9.8));
  assert.ok(!indexes().includes(10));
});

test('a /data that never loads never holds the answer of a stop', async () => {
  const store = memoryStore();
  store.load = () => new Promise(() => {});
  const t = await setup({ store, getConfigHangs: true, create: false });
  let answer;
  t.fire(F.STOP).then((a) => (answer = a));
  await t.advance(5 * SECOND, 50);
  assert.ok(answer, 'answered');
  refused(answer, /Aucune adresse/);
});
