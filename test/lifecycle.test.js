// -----------------------------------------------------------------------------
// Reads and lifecycle: never sooner than the interval (restart, button, scan,
// reconnection), nothing stale sent as new, secondary topics never blocking,
// credentials refused blocked and lifted by new ones, configurations saved in
// a row applied in order.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, FEATURES } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { HOST, NOW, PASSWORD, USER, fakeWarp } from './fixtures/fakeWarp.js';
import { CFG, DEVICE, MINUTE, SECOND, setup } from './helpers.js';
import { testClock } from './kit/clock.mjs';

const F = FEATURES;
const NAME = '/info/name';

test('a restart never reads sooner than the interval after the last read kept in /data', async () => {
  const store = memoryStore({ lastAttemptAt: NOW - 10 * SECOND });
  const t = await setup({ store, create: false, config: { ...CFG, poll_interval: 60 } });
  assert.equal(t.dev.count('GET', NAME), 0);
  await t.advance(MINUTE + 10 * SECOND, 500);
  assert.equal(t.dev.count('GET', NAME), 1);
});

test('the test button, a scan and a reconnection never read sooner than the interval', async () => {
  const t = await setup();
  const reads = t.dev.count('GET', NAME);
  const answer = await t.gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(JSON.stringify(answer), /jamais lue avant l'intervalle/);
  await t.gladys.fake.scanRequest();
  const reconnect = t.gladys.connect();
  await t.advance(SECOND, 50);
  await reconnect;
  assert.equal(t.dev.count('GET', NAME), reads);
  await t.advance(31 * SECOND, 100);
  assert.equal(t.dev.count('GET', NAME), reads + 1);
});

test('nothing stale: a device created after 3 minutes of failures gets only status and connector', async () => {
  const t = await setup({ create: false });
  t.dev.down = 'unreachable';
  await t.advance(4 * MINUTE, 1000);
  await t.gladys.fake.deviceCreated(t.gladys.fake.discoveredDevices[0]);
  await t.advance(2 * SECOND, 100);
  const roles = new Set(
    t.gladys.fake.states.map((s) => s.device_feature_external_id.split(':').at(-1)),
  );
  assert.deepEqual([...roles].sort(), [F.CONNECTOR, F.STATUS].sort());
  assert.equal(t.state(F.STATUS).text, 'Borne injoignable');
});

test('a reconnection to Gladys sends no value older than 2 minutes', async () => {
  const t = await setup();
  t.dev.down = 'unreachable';
  await t.advance(3 * MINUTE, 1000);
  const before = t.gladys.fake.states.length;
  const reconnect = t.gladys.connect();
  await t.advance(SECOND, 50);
  await reconnect;
  const sent = t.gladys.fake.states
    .slice(before)
    .map((s) => s.device_feature_external_id.split(':').at(-1));
  assert.ok(
    sent.every((role) => [F.STATUS, F.CONNECTOR].includes(role)),
    sent.join(),
  );
});

test('secondary topics failing (5xx, 401, 404) never hold the core values back', async () => {
  const t = await setup();
  t.dev.status['/power_manager/charge_mode'] = 404;
  t.dev.status['/meters/0/values'] = 500;
  t.dev.status['/charge_tracker/current_charge'] = 401;
  t.dev.slots[5].max_current = 10_000;
  await t.advance(31 * SECOND, 100);
  assert.equal(t.status().connected, true);
  assert.match(t.status().text, /Non lu cette fois : compteur, session, mode de charge/);
  assert.equal(t.state(F.ALLOWED_CURRENT).state, 10);
  assert.equal(t.app.blocked, false, 'a 401 there is not a refusal');
  assert.equal(t.app.paused, false, 'a 5xx there pauses nothing');
  // Tried again later, spaced; values back once they answer.
  delete t.dev.status['/meters/0/values'];
  await t.advance(3 * MINUTE, 1000);
  assert.doesNotMatch(t.status().text, /compteur,/);
});

test('a text value is never published as a measure 0', async () => {
  const t = await setup();
  t.dev.chargeMode = 4; // the resolver "default": not a mode
  await t.advance(31 * SECOND, 100);
  const numbers = t.gladys.fake.states.filter(
    (s) => s.device_feature_external_id.endsWith(F.CHARGE_MODE) && s.state !== undefined,
  );
  assert.equal(numbers.length, 0);
});

test('credentials refused: blocked (in /data), no tries meanwhile, lifted by new credentials', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers, auth: { user: USER, password: PASSWORD } });
  const store = memoryStore();
  const t = await setup({ clock, dev, store, config: { ...CFG, username: USER, password: 'bad' } });
  assert.ok(store.data.block);
  const reads = t.dev.requests.length;
  await t.advance(10 * MINUTE, 5000);
  assert.equal(t.dev.requests.length, reads, 'no automatic try during the block');
  const saved = t.gladys.fake.configUpdated({ ...CFG, username: USER, password: PASSWORD });
  await t.advance(2 * SECOND, 50);
  await saved;
  assert.equal(t.status().connected, true);
  assert.equal(store.data.block, null);
  assert.ok(!JSON.stringify(store.data).includes(PASSWORD));
});

test('a nonce renewed is answered again, never a refusal', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers, auth: { user: USER, password: PASSWORD } });
  const t = await setup({ clock, dev, config: { ...CFG, username: USER, password: PASSWORD } });
  dev.nonce = 'n0nce-2';
  await t.advance(31 * SECOND, 100);
  assert.equal(t.status().connected, true);
  assert.equal(t.app.blocked, false);
});

test('configurations saved in a row apply one at a time, the last one wins', async () => {
  const t = await setup();
  const a = t.gladys.fake.configUpdated({ host: '192.168.1.71' });
  const b = t.gladys.fake.configUpdated({ host: HOST, poll_interval: 60 });
  await t.advance(3 * SECOND, 50);
  await Promise.all([a, b]);
  assert.equal(t.app.config.address.host, HOST);
  assert.equal(t.app.config.pollInterval, 60);
});

test('a WARP Energy Manager, a redirect to HTTPS, an https:// address: said, nothing published', async () => {
  const t = await setup({ create: false });
  t.dev.type = 'wem';
  await t.advance(31 * SECOND, 100);
  assert.match(t.status().text, /n'est pas une borne WARP/);
  t.dev.type = 'warp3';
  t.dev.status[NAME] = 301;
  await t.advance(31 * SECOND, 100);
  assert.match(t.status().text, /redirige vers HTTPS/);
  const saved = t.gladys.fake.configUpdated({ host: 'https://192.168.1.70' });
  await t.advance(SECOND, 50);
  await saved;
  assert.match(t.status().text, /HTTPS n'est pas pris en charge/);
});

test('the transport badge: local when read, unreachable when down', async () => {
  const t = await setup();
  assert.equal(t.gladys.fake.transports.at(-1).transport, 'local');
  t.dev.down = 'unreachable';
  await t.advance(31 * SECOND, 100);
  assert.equal(t.gladys.fake.transports.at(-1).transport, 'unreachable');
  assert.equal(JSON.stringify(t.gladys.fake.transports.at(-1)).includes(DEVICE), true);
});

test('shutdown writes /data (time of the last read)', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.advance(30 * SECOND, 500);
  await t.app.shutdown();
  assert.ok(store.data.lastAttemptAt >= NOW);
});

test('a long interval: a reconnection 5 minutes after the read sends no old value', async () => {
  const t = await setup({ config: { ...CFG, poll_interval: 600 } });
  await t.advance(5 * MINUTE, 1000);
  const before = t.gladys.fake.states.length;
  const reconnect = t.gladys.connect();
  await t.advance(SECOND, 50);
  await reconnect;
  assert.equal(t.gladys.fake.states.length, before);
});

test('values left waiting while Gladys was unreachable are not sent 2 minutes later', async () => {
  const t = await setup();
  const publish = t.gladys.publishChangedStates.bind(t.gladys);
  let down = true;
  t.gladys.publishChangedStates = (...args) =>
    down ? Promise.reject(new Error('Gladys unreachable')) : publish(...args);
  t.dev.power = 3000;
  await t.advance(31 * SECOND, 100);
  t.dev.down = 'unreachable';
  await t.advance(3 * MINUTE, 1000);
  const before = t.gladys.fake.states.length;
  down = false;
  await t.advance(2 * SECOND, 100);
  const sent = t.gladys.fake.states.slice(before);
  assert.ok(!sent.some((s) => s.state === 3000), 'the old power never sent as new');
});

test('a read begun before a write left is never applied', async () => {
  const t = await setup();
  const before = t.app.charger.state;
  t.app.readAll = async () => {
    t.app.lastSentAt = t.app.mono();
    return {
      name: { uid: 'Xy7Kq', charger: true },
      state: { iec: 0, charger: 'not_connected' },
      slots: [],
      values: {},
      failed: [],
    };
  };
  await t.advance(31 * SECOND, 100);
  assert.equal(t.app.charger.state, before);
});

test('a charger without a readable uid: said, nothing published', async () => {
  const t = await setup({ create: false });
  const before = t.gladys.fake.discoveredDevices.length;
  t.dev.uid = 'bad uid';
  await t.advance(31 * SECOND, 100);
  assert.match(t.status().text, /pas d'UID lisible/);
  assert.equal(t.gladys.fake.discoveredDevices.length, before);
});
