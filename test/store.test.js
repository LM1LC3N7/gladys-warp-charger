// -----------------------------------------------------------------------------
// /data: a real file in a temporary folder (removed after), written whole
// (temporary file then rename, 0600), repaired when read; unreadable is not
// empty; no secret ever.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, normalizeMemory } from '../src/store.js';

const NOW = Date.parse('2026-10-28T10:00:00Z');

test('a round trip in a real file, 0600; a missing file is empty, a broken one unreadable', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'warp-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'warp-state.json');
  const store = fileStore(path);
  assert.deepEqual(await store.load(), { data: null });
  await store.save({ lastAttemptAt: NOW });
  assert.deepEqual(await store.load(), { data: { lastAttemptAt: NOW } });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, '{ broken');
  assert.deepEqual(await store.load(), { unreadable: true });
  await writeFile(path, 'x'.repeat(20_000));
  assert.deepEqual(await store.load(), { unreadable: true });
  assert.ok((await readFile(path, 'utf8')).length > 0);
});

test('repaired when read: bad addresses, dates in the future, waits too long', () => {
  const m = normalizeMemory(
    {
      target: { host: 'BAD HOST', port: 80 },
      lastAttemptAt: NOW + 3_600_000,
      stop: { host: '192.168.1.70', port: 80, since: NOW + 60_000, written: 'yes', resends: -1 },
      block: { until: NOW + 100 * 3_600_000, failures: 2 },
      pause: { until: NOW - 1, reason: '429' },
      flashAt: NOW + 60_000,
      index: { featureId: 'x', last: { value: 0, at: NOW } },
    },
    NOW,
  );
  assert.equal(m.target, null);
  assert.equal(m.lastAttemptAt, NOW);
  assert.deepEqual(m.stop, {
    host: '192.168.1.70',
    port: 80,
    since: NOW,
    written: false,
    resends: 0,
  });
  assert.equal(m.block.until, NOW + 6 * 3_600_000, 'never longer than the longest wait');
  assert.equal(m.pause, null, 'over');
  assert.equal(m.flashAt, NOW);
  assert.equal(m.index, null, 'a reference at 0 is none');
  assert.deepEqual(normalizeMemory([], NOW).stop, null);
});
