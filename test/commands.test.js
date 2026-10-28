// -----------------------------------------------------------------------------
// Start and the charging current (sensitive): behind the option, checked
// again right before the byte, decided on a fresh read, bounded, confirmed
// only by a read back, the flash spared.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { NOW, OTHER_UID, fakeWarp } from './fixtures/fakeWarp.js';
import { ALLOW, CFG, MINUTE, SECOND, ok, refused, setup } from './helpers.js';
import { testClock } from './kit/clock.mjs';

const F = FEATURES;
const GLOBAL = '/evse/global_current';
const EXTERNAL = '/evse/external_current';
const START = '/evse/start_charging';

async function slow({ latencyMs = 5, applyDelayMs = 50, config = ALLOW, store } = {}) {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers, latencyMs, applyDelayMs });
  return setup({ clock, dev, config, ...(store ? { store } : {}) });
}

test('an increase of the global current at most once a minute (flash), in /data first; a decrease never limited', async () => {
  const store = memoryStore();
  const t = await slow({ store });
  ok(await t.press(F.SET_CURRENT, '6'));
  assert.equal(store.data.flashAt, null, 'a decrease is not counted');
  ok(await t.press(F.SET_CURRENT, '10'));
  assert.ok(Number.isFinite(store.data.flashAt));
  refused(await t.press(F.SET_CURRENT, '12'), /une hausse par minute/);
  ok(await t.press(F.SET_CURRENT, '8'));
  assert.equal(t.dev.slots[5].max_current, 8_000);
  await t.advance(MINUTE, 500);
  ok(await t.press(F.SET_CURRENT, '12'));
  assert.equal(t.dev.writesTo(GLOBAL), 4);
});

test('the flash minute survives a restart (kept in /data)', async () => {
  const store = memoryStore({ flashAt: NOW - 10 * SECOND });
  const t = await slow({ store, config: { ...ALLOW, max_current: 32 } });
  refused(await t.press(F.SET_CURRENT, '20'), /une hausse par minute/);
  assert.equal(t.dev.writesTo(GLOBAL), 0);
});

test('a failed save of /data refuses the increase, nothing sent', async () => {
  const store = memoryStore(null, { failSave: true });
  const t = await slow({ store, config: { ...ALLOW, max_current: 32 } });
  refused(await t.press(F.SET_CURRENT, '20'), /\/data : rien envoyé/);
  assert.equal(t.dev.writesTo(GLOBAL), 0);
});

test('external control on: the external slot is written, never the flash', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  dev.externalEnabled = true;
  dev.slots[8] = { max_current: 16_000, active: true, clear_on_disconnect: false };
  const t = await setup({ clock, dev, config: ALLOW });
  ok(await t.press(F.SET_CURRENT, '12'));
  ok(await t.press(F.SET_CURRENT, '14'));
  assert.equal(t.dev.writesTo(EXTERNAL), 2);
  assert.equal(t.dev.writesTo(GLOBAL), 0);
  assert.equal(t.dev.slots[8].max_current, 14_000);
});

test('the bound: the ceiling and the cable limits, checked on the fresh read', async () => {
  const t = await slow({ config: { ...ALLOW, max_current: 32 } });
  t.dev.slots[1].max_current = 20_000; // the cable
  refused(await t.press(F.SET_CURRENT, '25'), /entre 6 et 20 A/);
  ok(await t.press(F.SET_CURRENT, '20'));
  assert.equal(t.dev.writes.at(-1).body.current, 20_000);
});

test('the read back equal to the value before: "not applied yet", then the same value is sent again', async () => {
  const t = await slow({ applyDelayMs: 3 * SECOND });
  refused(await t.press(F.SET_CURRENT, '10', 1000), /pas encore appliquée/);
  await t.advance(5 * SECOND, 100);
  assert.equal(t.dev.slots[5].max_current, 10_000);
  // Pending: never "already so" on a read that may not show it yet.
  await t.advance(MINUTE, 500);
  const writes = t.dev.writesTo(GLOBAL);
  await t.press(F.SET_CURRENT, '10');
  assert.equal(t.dev.writesTo(GLOBAL), writes + 1);
});

test('a read back that never comes: "sent, without confirmation"', async () => {
  const t = await slow();
  const ack = t.fire(F.SET_CURRENT, '10');
  await t.advance(300, 10);
  t.dev.silent.add(GLOBAL);
  await t.advance(5 * SECOND, 50);
  refused(await ack, /sans confirmation/);
  assert.equal(t.dev.writesTo(GLOBAL), 1);
});

test('the option turned off during the fresh read: nothing sent (checked right before the byte)', async () => {
  const t = await slow({ latencyMs: 400 });
  const ack = t.fire(F.SET_CURRENT, '10');
  await t.advance(500, 10);
  const saved = t.gladys.fake.configUpdated(CFG);
  await t.advance(5 * SECOND, 50);
  await saved;
  refused(await ack, /Autoriser les commandes|pas celle configurée/);
  assert.equal(t.dev.writesTo(GLOBAL), 0);
});

test('start: refused without a vehicle, on a fault; no write when already allowed', async () => {
  const t = await slow();
  ok(await t.press(F.START));
  assert.equal(t.dev.writesTo(START), 0, 'already allowed');
  ok(await t.press(F.STOP));
  t.dev.iec = 0;
  refused(await t.press(F.START), /Aucun véhicule/);
  t.dev.iec = 2;
  t.dev.error = 4;
  refused(await t.press(F.START), /défaut/);
  assert.equal(t.dev.writesTo(START), 0);
});

test('one command at a time; a command for another charger is refused', async () => {
  const t = await slow({ latencyMs: 200 });
  const first = t.fire(F.SET_CURRENT, '10');
  await t.advance(50, 10);
  refused(await t.fire(F.SET_CURRENT, '12'), /Une autre commande est en cours/);
  await t.advance(5 * SECOND, 50);
  ok(await first);
  t.dev.uid = OTHER_UID;
  refused(await t.press(F.SET_CURRENT, '8'), /Une autre borne répond/);
  assert.equal(t.dev.writesTo(GLOBAL), 1);
});

test('a slow charger (300 ms an answer): the current and the start are still confirmed within the ack', async () => {
  const t = await slow({ latencyMs: 300 });
  const ack = t.fire(F.SET_CURRENT, '10');
  const before = t.clock.monotonic();
  let at;
  ack.then(() => (at = t.clock.monotonic()));
  await t.advance(5 * SECOND, 20);
  ok(await ack);
  assert.ok(at - before < 4_300, `${at - before} ms`);
  ok(await t.press(F.STOP));
  ok(await t.press(F.START));
  assert.equal(t.dev.slots[4].max_current, 32_000);
});

test('a charger too slow to read before 3.5 s: nothing sent', async () => {
  const t = await slow({ latencyMs: 1200 });
  refused(await t.press(F.SET_CURRENT, '10', 6 * SECOND), /trop lente|n'a pas pu être lu/);
  assert.equal(t.dev.writesTo(GLOBAL), 0);
});

test('a 4xx answer to a write is a refusal; a 5xx "sent, without confirmation"', async () => {
  const t = await slow();
  t.dev.status[GLOBAL] = 400;
  // The GET of the fresh read fails too: a refusal before any write.
  refused(await t.press(F.SET_CURRENT, '10'), /n'a pas pu être lu/);
  delete t.dev.status[GLOBAL];
  const original = t.dev.transport;
  const answer = (status) => (o) => {
    if (o.method !== 'PUT') return original(o);
    o.beforeSend?.();
    return Promise.resolve({ status, headers: {}, body: '' });
  };
  t.dev.transport = answer(503);
  t.app.client.transport = t.dev.transport;
  refused(await t.press(F.SET_CURRENT, '10'), /sans confirmation/);
  await t.advance(MINUTE, 500);
  t.dev.transport = answer(400);
  t.app.client.transport = t.dev.transport;
  refused(await t.press(F.SET_CURRENT, '11'), /a refusé la commande/);
});

test('the option turned off while /data is written: the byte never leaves (checked in beforeSend)', async () => {
  const clock = testClock({ start: NOW });
  const store = memoryStore();
  const save = store.save.bind(store);
  store.save = (data) =>
    new Promise((resolve) => clock.timers.setTimeout(() => resolve(save(data)), 200));
  const dev = fakeWarp({ timers: clock.timers });
  const t = await setup({ clock, dev, store, config: { ...ALLOW, max_current: 32 } });
  const ack = t.fire(F.SET_CURRENT, '20');
  await t.advance(120, 5);
  t.app.config = { ...t.app.config, allowCommands: false };
  await t.advance(5 * SECOND, 50);
  refused(await ack, /Autoriser les commandes/);
  assert.equal(t.dev.writesTo(GLOBAL), 0);
});

test('with the option off, a command is refused as such even while another runs', async () => {
  const t = await slow({ latencyMs: 200 });
  const first = t.fire(F.SET_CURRENT, '10');
  await t.advance(50, 10);
  t.app.config = { ...t.app.config, allowCommands: false };
  refused(await t.fire(F.START), /Autoriser les commandes/);
  await t.advance(5 * SECOND, 50);
  await first;
});

test('a start not applied yet is sent again on the next click (never "already so" meanwhile)', async () => {
  const t = await slow({ applyDelayMs: 3 * SECOND });
  await t.press(F.STOP, 1, 5 * SECOND);
  await t.advance(4 * SECOND, 100);
  assert.equal(t.dev.slots[4].max_current, 0);
  refused(await t.press(F.START, 1, 1000), /pas encore appliquée/);
  await t.advance(4 * SECOND, 100);
  assert.equal(t.dev.slots[4].max_current, 32_000);
  await t.press(F.START);
  assert.equal(t.dev.writesTo(START), 2);
});

test('a connection that opens after 3.5 s never carries the command', async () => {
  const t = await slow();
  const transport = t.dev.transport;
  t.app.client.transport = (o) =>
    o.method === 'PUT'
      ? new Promise((resolve) => t.clock.timers.setTimeout(resolve, 3_600)).then(() => transport(o))
      : transport(o);
  refused(await t.press(F.SET_CURRENT, '10', 6 * SECOND), /trop lente|Non envoyé/);
  assert.equal(t.dev.writesTo(GLOBAL), 0);
});
