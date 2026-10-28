// -----------------------------------------------------------------------------
// The app on the REAL clock, sped up 20 times (30 s of the interval are 1.5 s,
// but it is the real clock: it moves between any two reads of it), against a
// real local HTTP server answering like the fake WARP charger: the reads
// really start at the interval, never sooner, one request at a time, and a
// stop goes at once.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { WarpApp } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { UID, fakeWarp } from './fixtures/fakeWarp.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { httpServer, reply } from './kit/http.mjs';

const SPEED = 20;
const INTERVAL = 30_000;

test('real clock x20: a read every interval, one request at a time, a stop at once', async () => {
  const dev = fakeWarp({ timers: globalThis, applyDelayMs: 0 });
  let open = 0;
  let peak = 0;
  const routes = {};
  for (const path of Object.keys(dev.get)) {
    routes[`GET ${path}`] = () => dev.get[path]();
  }
  for (const path of Object.keys(dev.put)) {
    routes[`PUT ${path}`] = (r) => {
      dev.put[path](r.json);
      return reply(200, '');
    };
  }
  const server = await httpServer({
    routes,
    latencyMs: () => {
      open += 1;
      peak = Math.max(peak, open);
      setTimeout(() => (open -= 1), 2);
      return 2;
    },
  });
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({ config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new WarpApp({
    gladys,
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  const spy = spyOn(app, 'run', clock);
  try {
    await app.connected({ host: `127.0.0.1:${server.port}`, poll_interval: INTERVAL / 1000 });
    const gaps = await measurePeriod(spy, { count: 3, period: INTERVAL });
    assert.equal(gaps.length, 2);
    assert.ok(peak <= 1, `${peak} requests at once`);
    assert.equal(gladys.fake.connectionStatus.connected, true);
    const started = clock.monotonic();
    await app.setValue(undefined, {
      external_id: `ext:test-integration:warp:${UID}:stop-charge`,
    });
    assert.equal(dev.slots[4].max_current, 0);
    assert.ok(clock.monotonic() - started < 4_300, 'within the ack budget');
  } finally {
    spy.restore();
    await app.shutdown();
    clock.close();
    await server.close();
  }
  assert.ok(clock.timersSet < 400, `${clock.timersSet} timers`);
});
