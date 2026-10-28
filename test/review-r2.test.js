// -----------------------------------------------------------------------------
// Review r2: a newer start that left lets a kept stop go unless clearly
// refused, and is always written while a stop is kept (I3); the waits under
// the line give way to a stop, the check re-armed on 'wait' and 'yield', a
// start allowed by the external control under the ceiling (m1).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES } from '../src/constants.js';
import { HOST, NOW, fakeWarp } from './fixtures/fakeWarp.js';
import { ALLOW, MINUTE, SECOND, ok, refused, setup } from './helpers.js';
import { testClock } from './kit/clock.mjs';

const F = FEATURES;
const STOP = '/evse/stop_charging';
const START = '/evse/start_charging';

test('I3a: a newer start answered 500 but applied lets the kept stop go: the charge is never cut', async () => {
  const t = await setup({ config: ALLOW });
  ok(await t.press(F.STOP));
  ok(await t.press(F.START));
  ok(await t.press(F.STOP)); // applied, watched for the start before it
  assert.ok(t.app.stopGuard);
  const transport = t.dev.transport;
  t.app.client.transport = (o) => {
    if (o.method === 'PUT' && o.path === START) {
      // Applied by the charger, answered with a server error.
      return transport(o).then(() => ({ status: 500, headers: {}, body: '' }));
    }
    return transport(o);
  };
  refused(await t.press(F.START), /sans confirmation/);
  assert.equal(t.app.stopGuard, undefined);
  const stops = t.dev.writesTo(STOP);
  await t.advance(2 * MINUTE, 500);
  assert.equal(t.dev.writesTo(STOP), stops);
  assert.equal(t.dev.slots[4].max_current, 32_000);
});

test('I3b: while a stop is kept, Start always writes and lets it go (never "already so")', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  dev.put[STOP] = () => {}; // the stop not applied: kept
  const t = await setup({ clock, dev, config: ALLOW });
  refused(await t.press(F.STOP), /pas encore appliqué/);
  assert.equal(dev.slots[4].max_current, 32_000);
  ok(await t.press(F.START));
  assert.equal(dev.writesTo(START), 1, 'written although the slot shows 32 A');
  assert.equal(t.app.stopGuard, undefined);
  const stops = dev.count('PUT', STOP);
  await t.advance(MINUTE, 500);
  assert.equal(dev.count('PUT', STOP), stops, 'no stop after the newer start');
});

test('m1: a stop clicked during the wait after a command write leaves within 250 ms', async () => {
  const t = await setup({ config: ALLOW });
  const times = [];
  const apply = t.dev.put[STOP];
  t.dev.put[STOP] = (body) => {
    times.push(t.clock.monotonic());
    apply(body);
  };
  const command = t.fire(F.SET_CURRENT, '10');
  for (let i = 0; i < 200 && t.dev.writesTo('/evse/global_current') === 0; i += 1) {
    await t.advance(5, 5);
  }
  await t.advance(50, 5); // inside the 600 ms wait before the read back
  const clicked = t.clock.monotonic();
  t.fire(F.STOP);
  await t.advance(2 * SECOND, 5);
  await command;
  assert.equal(times.length, 1);
  assert.ok(times[0] - clicked <= 250, `${times[0] - clicked} ms`);
});

test("m1: the check re-armed at sentAt + 2 s on 'wait', at 1 s on 'yield'", async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  const t = await setup({ clock, dev });
  const guard = t.app.newStopGuard({ host: HOST, port: 80 });
  guard.written = true;
  guard.sentAt = t.clock.monotonic();
  t.app.stopGuard = guard;
  const checking = t.app.runCheck();
  await t.advance(100, 5);
  await checking;
  assert.ok(guard.timer, 'armed');
  assert.ok(guard.dueAt - guard.sentAt <= 2_100, `wait: ${guard.dueAt - guard.sentAt} ms`);
  // A command arriving while the check waits for the line: it yields, armed 1 s later.
  t.clock.timers.clearTimeout(guard.timer);
  guard.timer = undefined;
  const line = await t.app.lane.acquire('read');
  const waiting = t.app.runCheck();
  await t.advance(10, 5);
  t.app.command = { role: 'set-current', seq: 0, sent: false };
  const before = t.clock.monotonic();
  line.release();
  await t.advance(10, 5);
  await waiting;
  assert.ok(guard.timer, 'armed');
  assert.ok(guard.dueAt - before <= 1_100, `yield: ${guard.dueAt - before} ms`);
  t.app.command = undefined;
  t.app.dropStopGuard('test');
});

test('m1: a start allowed when the external control is under the ceiling, the global above', async () => {
  const clock = testClock({ start: NOW });
  const dev = fakeWarp({ timers: clock.timers });
  dev.externalEnabled = true;
  dev.slots[8] = { max_current: 16_000, active: true, clear_on_disconnect: false };
  dev.slots[5].max_current = 32_000;
  const t = await setup({ clock, dev, config: ALLOW });
  ok(await t.press(F.STOP));
  ok(await t.press(F.START));
  assert.equal(dev.writesTo(START), 1);
});
