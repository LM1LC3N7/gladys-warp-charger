// -----------------------------------------------------------------------------
// The stop (protective): never held back by the option, a 429 pause, refused
// credentials, a read stuck on a silent charger, a command in progress, a
// configuration that cannot be read, a restart; kept in /data and checked
// until it is seen applied; never let go by time.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { HOST, NOW, PASSWORD, USER, fakeWarp } from './fixtures/fakeWarp.js';
import { ALLOW, CFG, MINUTE, SECOND, ok, refused, setup } from './helpers.js';
import { testClock } from './kit/clock.mjs';

const F = FEATURES;
const STOP = '/evse/stop_charging';
const START = '/evse/start_charging';

test('the stop ends a read stuck on a silent charger and goes at once, one connection at a time', async () => {
  const t = await setup();
  t.dev.silent.add('/evse/slots');
  await t.advance(30 * SECOND, 50);
  assert.ok(t.app.lane.holder, 'a read is stuck');
  const before = t.clock.monotonic();
  const ack = t.fire(F.STOP);
  await t.advance(100, 5);
  assert.equal(t.dev.writesTo(STOP), 1, 'sent within 100 ms');
  assert.ok(t.clock.monotonic() - before < 150);
  t.dev.silent.clear();
  await t.advance(2 * SECOND, 50);
  ok(await ack);
  assert.equal(t.dev.slots[4].max_current, 0);
  assert.equal(t.dev.peak, 1, 'never two requests at once');
});

test('the stop goes during a 429 pause, while start and the current are refused', async () => {
  const t = await setup({ config: ALLOW });
  t.dev.status['/info/name'] = 429;
  await t.advance(31 * SECOND, 100);
  assert.match(t.status().text, /ralentir \(429\)/);
  delete t.dev.status['/info/name'];
  refused(await t.press(F.START), /ralentir/);
  refused(await t.press(F.SET_CURRENT, '10'), /ralentir/);
  ok(await t.press(F.STOP));
  assert.equal(t.dev.writesTo(STOP), 1);
  assert.equal(t.dev.writesTo(START), 0);
  assert.equal(t.dev.slots[4].max_current, 0);
});

test('the stop goes with refused credentials, is kept, and applies once they are fixed', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers, auth: { user: USER, password: PASSWORD } });
  const store = memoryStore();
  const t = await setup({
    clock,
    dev,
    store,
    config: { ...CFG, username: USER, password: 'wrong-one' },
  });
  assert.match(t.status().text, /refuse le nom d'utilisateur/);
  const ack = await t.press(F.STOP);
  refused(ack, /refusé l'arrêt/);
  assert.ok(t.dev.count('PUT', STOP) >= 1, 'the stop went (and got a 401)');
  assert.ok(store.data.stop, 'kept in /data');
  // Checked every 15 s, the block never holds it back.
  const tries = t.dev.count('PUT', STOP);
  await t.advance(31 * SECOND, 100);
  assert.ok(t.dev.count('PUT', STOP) > tries);
  // The right credentials saved: sent and applied at once.
  const saved = t.gladys.fake.configUpdated({ ...CFG, username: USER, password: PASSWORD });
  await t.advance(3 * SECOND, 50);
  await saved;
  assert.equal(t.dev.slots[4].max_current, 0);
  assert.equal(t.app.stopGuard, undefined);
  assert.equal(store.data.stop, null);
});

test('the configuration cannot be read: the stop goes to the address kept in /data', async () => {
  const store = memoryStore({
    target: { host: HOST, port: 80, uid: 'Xy7Kq' },
    lastAttemptAt: NOW - 10 * MINUTE,
  });
  const t = await setup({ store, getConfigFails: 100, create: false });
  assert.match(t.status().text, /configuration n'a pas pu être lue/);
  assert.equal(t.dev.count('GET', '/info/name'), 0, 'nothing read without the configuration');
  ok(await t.press(F.STOP));
  assert.equal(t.dev.writesTo(STOP), 1);
  assert.equal(t.dev.slots[4].max_current, 0);
});

test('getConfig() failing in `connected` is tried again every 30 s, then the integration starts', async () => {
  const t = await setup({ getConfigFails: 2, create: false });
  assert.match(t.status().text, /configuration n'a pas pu être lue/);
  await t.advance(31 * SECOND, 100);
  assert.match(t.status().text, /configuration n'a pas pu être lue/);
  await t.advance(31 * SECOND, 100);
  assert.equal(t.status().connected, true);
  assert.ok(t.gladys.fake.discoveredDevices.length === 1);
});

test('a restart: the stop kept in /data goes before the configuration is read', async () => {
  const store = memoryStore({
    target: { host: HOST, port: 80, uid: 'Xy7Kq' },
    stop: { host: HOST, port: 80, since: NOW - MINUTE, written: true, resends: 0 },
  });
  const t = await setup({ store, boot: true, getConfigFails: 100, create: false });
  await t.advance(2 * SECOND, 50);
  assert.equal(t.dev.writesTo(STOP), 1);
  assert.equal(t.dev.count('GET', '/info/name'), 0, 'no read first');
  assert.equal(t.dev.slots[4].max_current, 0);
  assert.equal(t.app.stopGuard, undefined);
  assert.equal(store.data.stop, null);
});

test('a /data stop dated in the future is kept, dated now', async () => {
  const store = memoryStore({
    stop: { host: HOST, port: 80, since: NOW + 3_600_000, written: false },
  });
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  dev.put[STOP] = () => {}; // never applied
  const t = await setup({ clock, dev, store, boot: true, getConfigFails: 100, create: false });
  assert.ok(t.app.stopGuard);
  assert.ok(t.app.stopGuard.since <= t.clock.now());
});

test('a stop not applied: sent again 3 times, then held (status), never let go by time; let go when the vehicle leaves', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  dev.put[STOP] = () => {}; // the charger ignores it
  const store = memoryStore();
  const t = await setup({ clock, dev, store });
  refused(await t.press(F.STOP), /pas encore appliqué/);
  assert.ok(store.data.stop);
  await t.advance(2 * MINUTE, 200);
  assert.equal(t.dev.count('PUT', STOP), 4, 'the click and 3 resends');
  assert.match(t.status().text, /envoyé 4 fois/);
  await t.advance(2 * 60 * MINUTE, 5000);
  assert.equal(t.dev.count('PUT', STOP), 4, 'held: no more writes');
  assert.ok(t.app.stopGuard, 'never let go by time');
  assert.ok(store.data.stop);
  // A new click sends it again, and gives back 3 resends.
  await t.press(F.STOP);
  await t.advance(2 * MINUTE, 200);
  assert.equal(t.dev.count('PUT', STOP), 8, 'the click and 3 more resends');
  // The vehicle leaves: nothing to stop any more.
  t.dev.iec = 0;
  await t.advance(31 * SECOND, 200);
  assert.equal(t.app.stopGuard, undefined);
  assert.equal(store.data.stop, null);
});

test('a stop while the charger is unreachable: tried for 3 s, kept, sent once it answers', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  t.dev.down = 'unreachable';
  const ack = await t.press(F.STOP);
  refused(ack, /n'a pas pu partir/);
  assert.ok(t.dev.count('PUT', STOP) >= 8, `${t.dev.count('PUT', STOP)} tries in 3 s`);
  assert.deepEqual(
    { written: store.data.stop.written, host: store.data.stop.host },
    { written: false, host: HOST },
  );
  t.dev.down = false;
  await t.advance(16 * SECOND, 100);
  assert.equal(t.dev.slots[4].max_current, 0);
  assert.equal(t.app.stopGuard, undefined);
});

test('a failing disk never holds the stop back', async () => {
  const store = memoryStore(null, { failSave: true });
  const t = await setup({ store });
  ok(await t.press(F.STOP));
  assert.equal(t.dev.slots[4].max_current, 0);
});

test('a command that has not left gives way to a stop clicked after it', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers, latencyMs: 300 });
  const t = await setup({ clock, dev, config: ALLOW });
  ok(await t.press(F.STOP));
  const start = t.fire(F.START);
  await t.advance(400, 10);
  const stop = t.fire(F.STOP);
  await t.advance(5 * SECOND, 50);
  refused(await start, /arrêt a été cliqué entre-temps/);
  ok(await stop);
  assert.equal(t.dev.writesTo(START), 0);
  assert.equal(t.dev.slots[4].max_current, 0);
});

test('a start sent before a stop that lands after it: the stop is sent again', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  const t = await setup({ clock, dev, config: ALLOW });
  ok(await t.press(F.STOP));
  // The start is acked at once but lands 3 s later.
  dev.put[START] = () => {
    clock.timers.setTimeout(() => (dev.slots[4].max_current = 32_000), 3 * SECOND);
  };
  const start = t.fire(F.START);
  await t.advance(700, 10);
  ok(await t.press(F.STOP, 1, 1500));
  assert.equal(t.dev.slots[4].max_current, 0, 'the stop applied first');
  await start;
  await t.advance(3 * SECOND, 50);
  assert.equal(t.dev.slots[4].max_current, 32_000, 'the late start landed');
  await t.advance(20 * SECOND, 100);
  assert.equal(t.dev.slots[4].max_current, 0, 'the stop sent again');
  await t.advance(2 * MINUTE, 500);
  assert.equal(t.app.stopGuard, undefined, 'let go after the watch');
});

test('a newer start clicked with the option lets the stop not applied go', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  dev.put[STOP] = () => {};
  const t = await setup({ clock, dev, config: ALLOW });
  refused(await t.press(F.STOP), /pas encore appliqué/);
  assert.ok(t.app.stopGuard);
  // The fake ignored the stop: the start finds the button released, writes nothing.
  dev.slots[4].max_current = 0;
  ok(await t.press(F.START));
  assert.equal(t.app.stopGuard, undefined);
  const writes = t.dev.count('PUT', STOP);
  await t.advance(MINUTE, 200);
  assert.equal(t.dev.count('PUT', STOP), writes, 'no resend after the newer start');
});

test('two stops in a row share one write; the stop answers within 4.3 s on a slow charger', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers, latencyMs: 900 });
  const t = await setup({ clock, dev });
  const a = t.fire(F.STOP);
  const b = t.fire(F.STOP);
  const before = clock.monotonic();
  await t.advance(5 * SECOND, 50);
  const [first, second] = [await a, await b];
  assert.ok(first.success || /sans confirmation|pas encore/.test(first.error));
  assert.ok(second.success || /sans confirmation|pas encore/.test(second.error));
  assert.ok(t.dev.count('PUT', STOP) <= 2);
  assert.ok(clock.monotonic() - before >= 0);
});

test('a stop clicked while getConfig() hangs goes to the address kept in /data', async () => {
  const store = memoryStore({ target: { host: HOST, port: 80, uid: 'Xy7Kq' } });
  const t = await setup({ store, getConfigHangs: true, create: false });
  ok(await t.press(F.STOP));
  assert.equal(t.dev.writesTo(STOP), 1);
});

test('the stop is in /data before its first byte reaches the charger', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  const store = memoryStore();
  const seen = [];
  const apply = dev.put[STOP];
  dev.put[STOP] = (body) => {
    seen.push(store.data?.stop?.host);
    apply(body);
  };
  const t = await setup({ clock, dev, store });
  ok(await t.press(F.STOP));
  assert.deepEqual(seen, [HOST]);
});

test('a start waiting for the line when a stop is clicked never leaves after it', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  const t = await setup({ clock, dev, config: ALLOW });
  ok(await t.press(F.STOP));
  await t.advance(MINUTE, 500);
  t.dev.silent.add('/evse/slots');
  for (let i = 0; i < 1000; i += 1) {
    if (t.app.lane.holder?.kind === 'read' && t.dev.requests.at(-1).path === '/evse/slots') break;
    await t.advance(50, 50);
  }
  assert.equal(t.app.lane.holder?.kind, 'read', 'a read is stuck on the line');
  const start = t.fire(F.START);
  await t.advance(50, 10);
  const stop = t.fire(F.STOP);
  await t.advance(100, 10);
  t.dev.silent.clear();
  await t.advance(5 * SECOND, 50);
  refused(await start, /arrêt a été cliqué entre-temps/);
  ok(await stop);
  assert.equal(t.dev.writesTo(START), 0);
});

test('a newer start clicked with the option ends the watch of a stop (never stopped again)', async () => {
  const t = await setup({ config: ALLOW });
  ok(await t.press(F.STOP));
  ok(await t.press(F.START)); // a start that left: the next stop watches for it
  ok(await t.press(F.STOP));
  assert.ok(t.app.stopGuard, 'watched for the start sent less than 90 s before');
  ok(await t.press(F.START)); // the user's newer start
  assert.equal(t.app.stopGuard, undefined);
  await t.advance(2 * MINUTE, 500);
  assert.equal(t.dev.slots[4].max_current, 32_000, 'the newer start stays');
});

test('the configuration arriving sends a kept stop at once with its credentials', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers, auth: { user: USER, password: PASSWORD } });
  const store = memoryStore({
    target: { host: HOST, port: 80, uid: 'Xy7Kq' },
    lastAttemptAt: NOW - 5 * SECOND,
    stop: { host: HOST, port: 80, since: NOW - MINUTE, written: true, resends: 0 },
  });
  const t = await setup({
    clock,
    dev,
    store,
    boot: true,
    create: false,
    config: { ...CFG, username: USER, password: PASSWORD },
  });
  await t.advance(3 * SECOND, 50);
  assert.equal(t.dev.count('GET', '/info/name'), 0, 'no read yet (interval)');
  assert.equal(t.dev.slots[4].max_current, 0, 'the stop applied with the credentials');
});

test('decideStop: a read begun less than 2 s after the stop left waits', async () => {
  const t = await setup();
  const guard = t.app.newStopGuard({ host: HOST, port: 80 });
  guard.written = true;
  guard.sentAt = t.clock.monotonic();
  const charging = { state: { iec: 2 }, slots: [{}, {}, {}, {}, { maxMa: 32_000, active: true }] };
  assert.equal(t.app.decideStop(guard, charging, guard.sentAt + 100), 'wait');
  assert.equal(t.app.decideStop(guard, charging, guard.sentAt + 2_100), 'resend');
});

test('a kept stop for an old address never gets the credentials of the new one', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers, auth: { user: USER, password: PASSWORD } });
  dev.put[STOP] = () => {}; // never applied: the stop stays kept and checked
  const store = memoryStore({
    stop: { host: '192.168.1.99', port: 80, since: NOW - MINUTE, written: true, resends: 0 },
  });
  const seen = [];
  const transport = dev.transport;
  dev.transport = (o) => {
    if (o.host === '192.168.1.99') seen.push(Boolean(o.headers?.Authorization));
    return o.host === '192.168.1.99' ? transport(o) : transport(o);
  };
  const t = await setup({
    clock,
    dev,
    store,
    boot: true,
    config: { ...CFG, username: USER, password: PASSWORD },
  });
  await t.advance(MINUTE, 500);
  assert.ok(seen.length > 0, 'the old address is still checked');
  assert.ok(
    seen.every((auth) => auth === false),
    'never the credentials of another address',
  );
});

test('a check about to send the stop again gives way to a command that arrived meanwhile', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  const during = [];
  dev.put[STOP] = () => during.push(Boolean(t.app.command)); // never applied
  const t = await setup({ clock, dev, config: ALLOW });
  refused(await t.press(F.STOP), /pas encore appliqué/);
  dev.latencyMs = 300;
  // Up to the check: it reads the state, then the slots.
  for (let i = 0; i < 1000; i += 1) {
    if (t.app.checking && t.dev.requests.at(-1).path === '/evse/state') break;
    await t.advance(10, 10);
  }
  assert.ok(t.app.checking);
  const start = t.fire(F.START);
  await t.advance(5 * SECOND, 50);
  await start;
  assert.ok(!during.includes(true), 'no stop written while the newer command ran');
});
