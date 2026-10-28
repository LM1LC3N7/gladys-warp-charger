// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), with wall dates (a monotonic instant belongs to its process):
//   - `target`: the address and uid of the last charger read, where a stop
//     goes while the configuration is not read yet;
//   - `lastAttemptAt`: the time of the last read (written at most once a
//     minute, BEFORE the read), so a restart never reads sooner than the
//     interval;
//   - `stop`: the stop not seen applied (address, since, written, resends):
//     a restart sends it again at once, before the configuration is read;
//   - `index`: the energy index guard of the created device (src/guard.js);
//   - `block`: credentials refused (until, failures); `pause`: a 429 or a
//     5xx (until, reason);
//   - `flashAt`: the last increase written to `evse/global_current` (kept in
//     the flash of the charger: at most one a minute, restarts included).
// No secret (no user name, no password, no hash of them), no personal data.
// The file is readable by the container user only (0600), bounded and
// repaired when read. A file that cannot be read is not an empty one:
// `load()` says so, and the app then never overwrites it with a guess.
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { TIMINGS } from './constants.js';
import { uidOf } from './warp/model.js';

export const STATE_FILE = '/data/warp-state.json';
const MAX_BYTES = 16 * 1024;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /** `{ data }`, `{ data: null }` (no file) or `{ unreadable: true }`. */
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        return err?.code === 'ENOENT' ? { data: null } : { unreadable: true };
      }
      if (text.length > MAX_BYTES) return { unreadable: true };
      try {
        return { data: JSON.parse(text) };
      } catch {
        return { unreadable: true };
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null, { unreadable = false, failSave = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    unreadable,
    failSave,
    async load() {
      if (this.unreadable) return { unreadable: true };
      return { data: this.data === null ? null : JSON.parse(JSON.stringify(this.data)) };
    },
    async save(data) {
      if (this.failSave) throw new Error('disk full');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const intIn = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;

/** An address kept: a host name or IPv4 address in lower case, and a port. */
export function addressOf(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const host =
    typeof raw.host === 'string' && raw.host.length <= 253 && /^[a-z0-9.-]+$/.test(raw.host)
      ? raw.host
      : undefined;
  const port = intIn(raw.port, 1, 65535);
  return host && port ? { host, port } : undefined;
}

function normalizeStop(raw, now) {
  const address = addressOf(raw);
  if (!address) return undefined;
  // `since` only dates the status: a date in the future (a clock set back,
  // NTP not there yet) or none keeps the stop, dated now.
  const since = Number.isFinite(raw.since) && raw.since <= now ? raw.since : now;
  return {
    ...address,
    since,
    written: raw.written === true,
    // Never written: no resend can have been counted (a stop that never left is never held).
    resends: raw.written === true ? (intIn(raw.resends, 0, 100) ?? 0) : 0,
  };
}

const point = (p) =>
  p && Number.isFinite(p.value) && p.value > 0 && Number.isFinite(p.at)
    ? { value: p.value, at: p.at }
    : null;

function normalizeIndex(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.featureId !== 'string') return null;
  if (raw.featureId.length > 300) return null;
  const last = point(raw.last);
  if (!last) return null;
  const h = raw.held;
  const held =
    h &&
    (h.direction === 'up' || h.direction === 'down') &&
    [h.from, h.to, h.threshold, h.at].every(Number.isFinite)
      ? { direction: h.direction, from: h.from, to: h.to, threshold: h.threshold, at: h.at }
      : null;
  return { featureId: raw.featureId, last, held };
}

/** A wait kept in /data (wall `until`): never longer than `max` from now (a clock set back). */
function normalizeWait(raw, now, max, extra) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.until) || raw.until <= now) {
    return null;
  }
  return { ...extra(raw), until: Math.min(raw.until, now + max) };
}

/**
 * The persisted state, repaired and bounded (see the header). A time in the
 * future for `lastAttemptAt` or `flashAt` counts as now: never a longer wait
 * than the interval or the minute.
 */
export function normalizeMemory(raw, now) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const target = addressOf(data.target);
  const uid = uidOf(data.target?.uid);
  return {
    target: target ? { ...target, uid: uid ?? null } : null,
    lastAttemptAt: Number.isFinite(data.lastAttemptAt) ? Math.min(data.lastAttemptAt, now) : null,
    stop: normalizeStop(data.stop, now) ?? null,
    index: normalizeIndex(data.index),
    block: normalizeWait(data.block, now, TIMINGS.authBackoff.at(-1), (b) => ({
      failures: intIn(b.failures, 1, 1000) ?? 1,
    })),
    pause: normalizeWait(data.pause, now, TIMINGS.rateLimitMax, (p) => ({
      reason: p.reason === '5xx' ? '5xx' : '429',
    })),
    flashAt: Number.isFinite(data.flashAt) ? Math.min(data.flashAt, now) : null,
  };
}
