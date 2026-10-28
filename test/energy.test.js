// -----------------------------------------------------------------------------
// The energy index (MeterValueID 209, kWh since manufacturing): through the
// guard of gladys-p1-monitor on the session clock; never 0, never a drop nor
// a jump published without the user (two clicks, bounded); a signal in the
// status; kept in /data.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, FEATURES } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { NOW, fakeWarp } from './fixtures/fakeWarp.js';
import { DEVICE, MINUTE, SECOND, setup } from './helpers.js';
import { testClock } from './kit/clock.mjs';

const F = FEATURES;
const indexStates = (t) =>
  t.gladys.fake.states
    .filter((s) => s.device_feature_external_id === `${DEVICE}:${F.TOTAL_ENERGY}`)
    .map((s) => s.state);
const accept = (t) => t.gladys.fake.action(ACTIONS.ACCEPT_HELD_INDEX);
const text = (answer) => answer?.message?.fr ?? answer?.fr ?? JSON.stringify(answer);

test('a rise within the margin is published; 0 and null never are', async () => {
  const t = await setup();
  assert.deepEqual(indexStates(t), [1234.5]);
  t.dev.energy = 1235.1;
  await t.advance(31 * SECOND, 100);
  assert.equal(indexStates(t).at(-1), 1235.1);
  t.dev.energy = 0;
  await t.advance(31 * SECOND, 100);
  t.dev.meterIds = [1, 74, 211];
  await t.advance(MINUTE, 100);
  assert.ok(!indexStates(t).includes(0));
  assert.ok(indexStates(t).every((v) => v >= 1234.5));
});

test('a drop (meter reset or replaced) is held, said in the status, taken in two clicks', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  t.dev.energy = 3.2;
  await t.advance(31 * SECOND, 100);
  assert.ok(!indexStates(t).includes(3.2));
  assert.match(t.status().text, /Index d'énergie retenu : baisse de 1234,5 à 3,2 kWh/);
  assert.equal(store.data.index.held.direction, 'down');
  // First click: lists it. A second click too soon (< 3 s) is a first one again.
  assert.match(text(await accept(t)), /Retenu : une baisse/);
  assert.match(text(await accept(t)), /Retenu : une baisse/);
  await t.advance(4 * SECOND, 100);
  assert.match(text(await accept(t)), /Pris : la baisse/);
  await t.advance(31 * SECOND, 100);
  assert.equal(indexStates(t).at(-1), 3.2);
  assert.doesNotMatch(t.status().text, /retenu/);
});

test('a jump is held; never confirmed by time nor repetition', async () => {
  const t = await setup();
  t.dev.energy = 5000;
  for (let i = 0; i < 20; i += 1) await t.advance(31 * SECOND, 500);
  await t.advance(3 * 60 * MINUTE, 10_000);
  assert.ok(!indexStates(t).includes(5000));
  assert.match(t.status().text, /saut de 1234,5 à 5000 kWh/);
});

test('the second click takes only what was listed: a value changed meanwhile is not taken', async () => {
  const t = await setup();
  t.dev.energy = 3.2;
  await t.advance(31 * SECOND, 100);
  await accept(t);
  t.dev.energy = 2.0;
  await t.advance(31 * SECOND, 100);
  assert.match(text(await accept(t)), /a changé depuis le premier clic/);
});

test('the session clock: the wall clock moved hours by NTP never widens the margin', async () => {
  const clock = testClock({ start: NOW });
  let offset = 0;
  const shifted = { ...clock, now: () => clock.now() + offset };
  const dev = fakeWarp({ timers: clock.timers });
  const t = await setup({ clock: shifted, dev });
  offset = 6 * 60 * MINUTE; // NTP sets the clock 6 h ahead
  t.dev.energy = 1234.5 + 100; // 100 kWh in 30 s: fits 6 h at 25 kW, not 30 s
  await t.advance(31 * SECOND, 100);
  assert.ok(!indexStates(t).includes(1334.5));
  assert.match(t.status().text, /saut/);
});

test('the held value survives a restart (/data); an unreadable /data is never overwritten', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  t.dev.energy = 3.2;
  await t.advance(31 * SECOND, 100);
  await t.app.shutdown();
  const clock2 = testClock({ start: NOW + MINUTE });
  const dev2 = fakeWarp({ timers: clock2.timers });
  dev2.energy = 3.2;
  const t2 = await setup({
    clock: clock2,
    dev: dev2,
    store,
    create: false,
    devices: t.gladys.fake.devices,
  });
  await t2.advance(MINUTE, 200);
  assert.ok(!indexStates(t2).includes(3.2));
  assert.match(t2.status().text, /Index d'énergie retenu/);
  const unreadable = memoryStore({ lastAttemptAt: NOW }, { unreadable: true });
  const t3 = await setup({ store: unreadable });
  await t3.advance(MINUTE, 200);
  assert.equal(unreadable.saves, 0);
});

test('a deleted device drops its guard (a new device starts a new index)', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  t.dev.energy = 3.2;
  await t.advance(31 * SECOND, 100);
  const device = t.gladys.fake.devices.find((d) => d.external_id === DEVICE);
  t.gladys.fake.devices = [];
  await t.gladys.fake.deviceDeleted(device);
  assert.equal(store.data.index, null);
});

test('the second click never takes another hold with the same value (from changed)', async () => {
  const t = await setup();
  t.dev.energy = 3.2;
  await t.advance(31 * SECOND, 100);
  await accept(t);
  t.dev.energy = 1234.6; // back: the hold ends, 1234.6 the reference
  await t.advance(31 * SECOND, 100);
  t.dev.energy = 3.2; // a new drop, from 1234.6 this time
  await t.advance(31 * SECOND, 100);
  assert.match(text(await accept(t)), /a changé depuis le premier clic/);
  assert.ok(!indexStates(t).includes(3.2));
});
