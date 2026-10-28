// -----------------------------------------------------------------------------
// A fake WARP charger behind the transport of src/warp/client.js (no
// network): the topics of the API reference (docs.warp-charger.com), with
// their documented shapes, Digest authentication (realm esp32-lib, qop auth)
// when users are set, a delayed effect of the writes, latency and failures
// on demand. Its timers are those of the test clock.
//
// Behaviour taken from the documentation of the topics written:
//   - `evse/stop_charging` sets the button slot (4) to 0, `evse/start_charging`
//     to 32 A, both only while a vehicle is plugged in (IEC state not A);
//   - `evse/global_current` and `evse/external_current` set slots 5 and 8;
//   - the allowed current is the lowest of the active slots; a vehicle
//     plugged in charges while it is above 0.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { ChargerError, ERROR_KINDS } from '../../src/warp/http.js';

export const HOST = '192.168.1.70';
export const UID = 'Xy7Kq';
export const OTHER_UID = 'Zz9Ab';
export const USER = 'gladys';
export const PASSWORD = 'pass-Wort-42';
export const TAG = 'nfc-tag-0451';
export const NOW = Date.parse('2026-10-28T10:00:00Z');

const md5 = (text) => createHash('md5').update(text).digest('hex');

export function fakeWarp({ timers, latencyMs = 5, applyDelayMs = 50, auth } = {}) {
  const slots = Array.from({ length: 18 }, () => ({
    max_current: 32_000,
    active: false,
    clear_on_disconnect: false,
  }));
  for (const index of [0, 1, 4, 5]) slots[index].active = true;
  slots[0].max_current = 32_000;
  slots[1].max_current = 32_000;
  slots[5].max_current = 16_000;
  const dev = {
    uid: UID,
    type: 'warp3',
    iec: 2,
    error: 0,
    slots,
    externalEnabled: false,
    energy: 1234.5,
    power: 7200,
    meterIds: [1, 74, 209, 211],
    meterStart: 1230,
    sessionUser: 0,
    chargeMode: 0,
    latencyMs,
    applyDelayMs,
    auth,
    nonce: 'n0nce-1',
    /** Fails every request with this kind ('unreachable', 'timeout'), or false. */
    down: false,
    /** Topics answered with a status: { '/power_manager/charge_mode': 404 }. */
    status: {},
    /** Topics that never answer (until the timeout or an abort). */
    silent: new Set(),
    /** Every request: { method, path, body, at, auth }. */
    requests: [],
    /** Writes that reached the charger: { path, body, at }. */
    writes: [],
    open: 0,
    peak: 0,
    timers,
  };

  const allowed = () => {
    let min;
    for (const s of dev.slots) {
      if (s.active) min = min === undefined ? s.max_current : Math.min(min, s.max_current);
    }
    return min ?? 0;
  };
  const state = () => {
    const ma = allowed();
    const iec = dev.iec === 0 ? 0 : dev.iec === 4 ? 4 : ma > 0 ? 2 : 1;
    const charger = iec === 0 ? 0 : iec === 4 || dev.error ? 4 : ma > 0 ? 3 : 1;
    return {
      iec61851_state: iec,
      charger_state: charger,
      contactor_state: 0,
      contactor_error: 0,
      allowed_charging_current: ma,
      error_state: dev.error,
      lock_state: 0,
      dc_fault_current_state: 0,
    };
  };
  const meterValue = (id) =>
    id === 74
      ? allowed() > 0 && dev.iec !== 0
        ? dev.power
        : 0
      : id === 209
        ? dev.energy
        : id === 1
          ? 230.1
          : 0;

  dev.get = {
    '/info/name': () => ({
      name: `${dev.type}-${dev.uid}`,
      type: dev.type,
      display_type: 'WARP3 Charger Pro 22kW',
      uid: dev.uid,
    }),
    '/info/version': () => ({ firmware: '2.6.4+675aeb6a', config: '2.6.4', config_type: 'warp3' }),
    '/evse/state': state,
    '/evse/slots': () => dev.slots.map((s) => ({ ...s })),
    '/evse/global_current': () => ({ current: dev.slots[5].max_current }),
    '/evse/external_enabled': () => ({ enabled: dev.externalEnabled }),
    '/evse/external_current': () => ({ current: dev.slots[8].max_current }),
    '/meters/0/value_ids': () => [...dev.meterIds],
    '/meters/0/values': () => dev.meterIds.map(meterValue),
    '/charge_tracker/current_charge': () => ({
      user_id: dev.sessionUser,
      meter_start: dev.meterStart,
      evse_uptime_start: 786598059,
      timestamp_minutes: 28577341,
      authorization_type: 2,
      authorization_info: { tag_type: 2, tag_id: TAG },
    }),
    '/power_manager/charge_mode': () => ({ mode: dev.chargeMode }),
  };

  dev.put = {
    '/evse/stop_charging': () => {
      if (dev.iec !== 0) dev.later(() => (dev.slots[4].max_current = 0));
    },
    '/evse/start_charging': () => {
      if (dev.iec !== 0) dev.later(() => (dev.slots[4].max_current = 32_000));
    },
    '/evse/global_current': (body) => {
      dev.later(() => (dev.slots[5].max_current = body.current));
    },
    '/evse/external_current': (body) => {
      dev.later(() => (dev.slots[8].max_current = body.current));
    },
  };

  /** The effect of a write, `applyDelayMs` after its answer (a controller applies it later). */
  dev.later = (fn) => {
    if (dev.applyDelayMs <= 0) fn();
    else timers.setTimeout(fn, dev.applyDelayMs);
  };

  const challenge = () => ({
    status: 401,
    headers: {
      'www-authenticate': `Digest realm="esp32-lib", qop="auth", nonce="${dev.nonce}", opaque="0p4que"`,
    },
    body: '',
  });

  /** Checks a Digest answer, as the firmware does: our own computation. */
  const authorized = (method, path, header) => {
    if (!dev.auth) return true;
    if (typeof header !== 'string' || !header.startsWith('Digest ')) return false;
    const f = Object.fromEntries(
      [...header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)].map((m) => [
        m[1],
        m[2] ?? m[3],
      ]),
    );
    if (f.username !== dev.auth.user || f.nonce !== dev.nonce || f.uri !== path) return false;
    const ha1 = md5(`${dev.auth.user}:esp32-lib:${dev.auth.password}`);
    const ha2 = md5(`${method}:${path}`);
    return f.response === md5(`${ha1}:${dev.nonce}:${f.nc}:${f.cnonce}:auth:${ha2}`);
  };

  dev.transport = (options) =>
    new Promise((resolve, reject) => {
      const { method, path, headers = {}, body, timeoutMs = 5000, signal, beforeSend } = options;
      const record = { method, path, body, auth: Boolean(headers.Authorization) };
      dev.requests.push(record);
      let sent = false;
      let done = false;
      const end = (fn, value) => {
        if (done) return;
        done = true;
        dev.open -= 1;
        timers.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (value instanceof ChargerError) value.sent = sent;
        fn(value);
      };
      dev.open += 1;
      dev.peak = Math.max(dev.peak, dev.open);
      const onAbort = () => end(reject, new ChargerError(ERROR_KINDS.ABORTED, 'Aborted'));
      if (signal?.aborted) {
        dev.open -= 1;
        reject(new ChargerError(ERROR_KINDS.ABORTED, 'Aborted'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = timers.setTimeout(
        () =>
          end(
            reject,
            sent
              ? new ChargerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout')
              : new ChargerError(ERROR_KINDS.UNREACHABLE, 'Unreachable: timeout'),
          ),
        timeoutMs,
      );
      if (dev.down === 'unreachable') {
        end(reject, new ChargerError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED'));
        return;
      }
      // Connected: the request leaves now.
      try {
        beforeSend?.();
      } catch (err) {
        end(reject, new ChargerError(ERROR_KINDS.YIELDED, err.message, { cause: err }));
        return;
      }
      sent = true;
      if (dev.down === 'timeout' || dev.silent.has(path)) return;
      timers.setTimeout(
        () => {
          if (done) return;
          const status = dev.status[path];
          if (status) {
            end(resolve, { status, headers: {}, body: status === 404 ? 'not found' : 'error' });
            return;
          }
          if (!authorized(method, path, headers.Authorization)) {
            end(resolve, challenge());
            return;
          }
          if (method === 'GET') {
            const fn = dev.get[path];
            if (!fn) {
              end(resolve, { status: 404, headers: {}, body: 'not found' });
              return;
            }
            end(resolve, { status: 200, headers: {}, body: JSON.stringify(fn()) });
            return;
          }
          const fn = dev.put[path];
          if (!fn) {
            end(resolve, { status: 404, headers: {}, body: 'not found' });
            return;
          }
          const json = JSON.parse(body);
          dev.writes.push({ path, body: json });
          fn(json);
          end(resolve, { status: 200, headers: {}, body: '' });
        },
        valueOf(dev.latencyMs, path),
      );
    });

  dev.count = (method, path) =>
    dev.requests.filter((r) => r.method === method && r.path === path).length;
  dev.writesTo = (path) => dev.writes.filter((w) => w.path === path).length;
  return dev;
}

const valueOf = (v, path) => (typeof v === 'function' ? v(path) : v);
