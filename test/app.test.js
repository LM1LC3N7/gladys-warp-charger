// -----------------------------------------------------------------------------
// End to end: the SDK wiring against the fake Gladys and a fake WARP charger
// (test/helpers.js), on the virtual clock: reads, device, states, status,
// commands.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES } from '../src/constants.js';
import { CHARGING_STATE, CONNECTOR_STATUS } from '../src/devices.js';
import { memoryStore } from '../src/store.js';
import { OTHER_UID, PASSWORD, TAG, USER, fakeWarp } from './fixtures/fakeWarp.js';
import { ALLOW, CFG, DEVICE, MINUTE, SECOND, ok, refused, setup } from './helpers.js';
import { testClock } from './kit/clock.mjs';
import { NOW } from './fixtures/fakeWarp.js';

const F = FEATURES;

test('a read: one device keyed by the uid, its states, the status connected', async () => {
  const t = await setup();
  const [device] = t.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, 'WARP Xy7Kq');
  assert.equal(device.model, 'WARP3 Charger Pro 22kW');
  assert.equal(t.state(F.STATUS).text, 'En charge');
  assert.equal(t.state(F.POWER).state, 7200);
  assert.equal(t.state(F.ALLOWED_CURRENT).state, 16);
  assert.equal(t.state(F.PLUGGED).state, 1);
  assert.equal(t.state(F.CONNECTOR).state, CONNECTOR_STATUS.OCCUPIED);
  assert.equal(t.state(F.CHARGING_STATE).state, CHARGING_STATE.CHARGING);
  assert.equal(t.state(F.SESSION_ENERGY).state, 4.5);
  assert.equal(t.state(F.TOTAL_ENERGY).state, 1234.5);
  assert.equal(t.state(F.CHARGE_MODE).text, 'Rapide');
  assert.equal(t.state(F.SET_CURRENT).text, '16');
  assert.equal(t.state(F.ERROR).state, 0);
  assert.equal(t.status().connected, true);
  assert.match(
    t.status().text,
    /^Connecté : WARP3 Charger Pro 22kW \(Xy7Kq\), En charge, 7200 W\./,
  );
  // The NFC tag of the session is never kept, logged nor stored.
  assert.ok(!JSON.stringify(t.gladys.fake.requests).includes(TAG));
  assert.ok(!t.lines.join('\n').includes(TAG));
  assert.ok(!JSON.stringify(t.store.data).includes(TAG));
  // One request at a time.
  assert.equal(t.dev.peak, 1);
});

test('the stop goes without the option, at once, and is confirmed by the read back', async () => {
  const t = await setup();
  const ack = await t.press(F.STOP);
  ok(ack);
  assert.equal(t.dev.slots[4].max_current, 0);
  assert.equal(t.dev.writesTo('/evse/stop_charging'), 1);
  assert.equal(t.app.stopGuard, undefined);
  assert.equal(t.store.data.stop, null);
});

test('start and the current refuse while the option is off', async () => {
  const t = await setup();
  refused(await t.press(F.START), /Autoriser les commandes/);
  refused(await t.press(F.SET_CURRENT, '10'), /Autoriser les commandes/);
  assert.equal(t.dev.writes.length, 0);
});

test('with the option: the current is set, bounded, confirmed by the read back', async () => {
  const t = await setup({ config: ALLOW });
  ok(await t.press(F.SET_CURRENT, '10'));
  assert.equal(t.dev.slots[5].max_current, 10_000);
  refused(await t.press(F.SET_CURRENT, '20'), /entre 6 et 16 A/);
  refused(await t.press(F.SET_CURRENT, '5'), /entre 6 et 16 A/);
  refused(await t.press(F.SET_CURRENT, '1.5'), /nombre entier/);
  assert.equal(t.dev.writesTo('/evse/global_current'), 1);
});

test('with the option: a start after a stop', async () => {
  const t = await setup({ config: ALLOW });
  ok(await t.press(F.STOP));
  assert.equal(t.dev.slots[4].max_current, 0);
  ok(await t.press(F.START));
  assert.equal(t.dev.slots[4].max_current, 32_000);
});

test('a start is refused when the charger would give more than the ceiling', async () => {
  const t = await setup({ config: ALLOW });
  ok(await t.press(F.STOP));
  t.dev.slots[5].max_current = 32_000;
  refused(await t.press(F.START), /32 A, au-dessus du plafond de 16 A/);
  assert.equal(t.dev.writesTo('/evse/start_charging'), 0);
});

test('digest credentials: the reads answer the challenge; the password never leaves', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers, auth: { user: USER, password: PASSWORD } });
  const t = await setup({ clock, dev, config: { ...CFG, username: USER, password: PASSWORD } });
  assert.equal(t.status().connected, true);
  assert.ok(!JSON.stringify(t.dev.requests).includes(PASSWORD));
  assert.ok(!t.lines.join('\n').includes(PASSWORD));
  assert.ok(!JSON.stringify(t.store.data).includes(PASSWORD));
  assert.ok(!JSON.stringify(t.gladys.fake.requests).includes(PASSWORD));
});

test('another charger at the address: the old device unreachable, said in the status', async () => {
  const t = await setup();
  t.dev.uid = OTHER_UID;
  await t.advance(31 * SECOND, 100);
  assert.equal(t.status().connected, false);
  assert.match(t.status().text, /Une autre borne répond/);
});

test('the store: the stop and the time of the last read, never a secret', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  assert.ok(Number.isFinite(store.data.lastAttemptAt));
  assert.deepEqual(store.data.target, { host: '192.168.1.70', port: 80, uid: 'Xy7Kq' });
  await t.advance(MINUTE);
});
