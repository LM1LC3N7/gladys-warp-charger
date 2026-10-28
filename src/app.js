// -----------------------------------------------------------------------------
// The integration: the WARP charger typed in the configuration (one address,
// optionally the user name and password of its web interface), one read of
// it every poll interval, its Gladys device and states, the energy index
// guard, the transport badge, the "Test the connection" and "Accept the held
// index" buttons, the commands (start, charging current: only when the
// configuration allows them) and the stop (never held back). index.js only
// wires the SDK handlers to it.
//
// One HTTP exchange at a time on the line (src/lane.js): the reads of a
// poll, a command (its fresh read, its write, its read back), the stop.
//
// Reads:
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart (the time of the last read is kept in
//     /data, written at most once a minute, BEFORE the read); only the reads
//     that follow a command (5 s, 20 s);
//   - `info/name` first in every read: the values go to the device of that
//     uid; `evse/state` and `evse/slots` are the core of a read; the meter,
//     the session, the current set and the charge mode are secondary: one
//     that fails never holds the others back (tried again later, said in the
//     status);
//   - a read begun before a write left is not applied; values older than
//     2 minutes are never sent as new;
//   - the energy index (MeterValueID 209) goes through src/guard.js on the
//     session clock: never 0, a jump or a drop held until the user accepts it
//     in two clicks.
//
// Commands (start, charging current):
//   - refused unless "Allow the commands" is on, checked on arrival and again
//     right before every write (in `beforeSend`, nothing in between);
//   - decided on a fresh read (identity, state, slots, current), never on
//     the state in memory; refused when a value they need is missing;
//   - the current bounded to 6 A .. min(ceiling, cable limits); a start
//     refused when the current the charger would give is above the ceiling;
//   - one at a time; the first write leaves by 3.5 s after the click or not
//     at all; answered by 4.3 s; confirmed only by a read back showing what
//     was asked ("sent, not applied yet" when it shows what was there
//     before, "sent, without confirmation" when it cannot be read);
//   - an increase of `evse/global_current` (written to the flash of the
//     charger) at most once a minute, its time in /data before the first
//     byte (a failed save refuses); a decrease is never limited.
//
// The stop (`evse/stop_charging`, the button slot at 0) protects: never held
// back by the option, the bounds, a read or a command in progress (it ends
// them), a failed read, a 429 or 5xx pause, refused credentials, a charger
// never read, nor a configuration not read yet (it goes to the address of
// the last read kept in /data, and a stop kept there is sent again at the
// start of the container, before the configuration). A command that arrived
// before it and has not left gives way. Tried again every 250 ms for 3 s;
// not seen applied, it is kept in /data and checked every 15 s: sent again
// while the charger still allows the charge (3 times at most, then held and
// said in the status), let go when the button slot reads 0, when no vehicle
// is plugged in, or when a newer start clicked in Gladys left. Never by time.
//
// Clocks: `monotonic` paces everything in memory (reads, retries, waits,
// deadlines), so that a wall clock moved by NTP never stops nor hurries
// them; the guard of the energy index runs on the session clock (the wall
// clock read once at the start plus the monotonic time since); the wall
// clock only dates what /data keeps for the next process.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, credentialsKey, normalizeConfig } from './config.js';
import {
  BUTTON_RELEASED_MA,
  FEATURES,
  INDEX_MAX_KW,
  INDEX_SLACK_KWH,
  METER,
  PRESSED,
  SECOND,
  SLOT,
  TIMINGS,
  TOPICS,
} from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  chargerIds,
  currentBounds,
  deviceName,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
  statusText,
} from './devices.js';
import { IndexGuard } from './guard.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { Lane } from './lane.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';
import { WarpClient, errorReason } from './warp/client.js';
import { ChargerError, ERROR_KINDS } from './warp/http.js';
import {
  cablesKnown,
  capFixed,
  meterValue,
  parseChargeMode,
  parseCurrent,
  parseCurrentCharge,
  parseEnabled,
  parseMeterIds,
  parseMeterValues,
  parseName,
  parseSlots,
  parseState,
  parseVersion,
} from './warp/model.js';

const round3 = (value) => Math.round(value * 1000) / 1000;
const sameAddress = (a, b) => Boolean(a && b) && a.host === b.host && a.port === b.port;

/** The index Gladys already holds for a feature of a created device, when it says so. */
function lastValueOf(feature) {
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

/** The secondary topics of a read: their failure never holds the core values back. */
const SECONDARY = ['version', 'meterIds', 'meterValues', 'currentCharge', 'setting', 'chargeMode'];

const freshCharger = () => ({
  uid: undefined,
  type: undefined,
  displayType: undefined,
  firmware: undefined,
  state: undefined,
  slots: undefined,
  meterIds: undefined,
  power: undefined,
  energy: undefined,
  sessionEnergy: undefined,
  setting: undefined,
  chargeMode: undefined,
  /** Monotonic time the last applied read started (-Infinity: none). */
  readAt: -Infinity,
  /** Monotonic time `info/version` and `meters/0/value_ids` were last read. */
  slowAt: -Infinity,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
  /** name -> { failures, nextAt, reason }: the secondary topics that failed. */
  secondary: new Map(),
  /** The energy index the guard let through, to publish (undefined: nothing). */
  indexValue: undefined,
});

export class WarpApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'warp-charger' }),
    transport,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.wallStart = now();
    this.monoStart = monotonic();
    this.client = new WarpClient({ transport, now: monotonic });
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.lane = new Lane();
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    /** /data could not be read: never overwritten (a guess would lose what it holds). */
    this.memoryUnreadable = false;
    this.memoryLoaded = undefined;
    this.charger = freshCharger();
    this.generation = 0;
    this.started = false;
    this.configRead = false;
    this.configSeq = 0;
    this.savedRaw = undefined;
    this.configChain = Promise.resolve();
    this.configTimer = undefined;
    /** Monotonic deadlines of a 429/5xx pause and of a credentials block. */
    this.pausedUntil = -Infinity;
    this.blockedUntil = -Infinity;
    /** Monotonic time of the last read sent (never sooner than the interval). */
    this.lastAttemptAt = -Infinity;
    this.attemptSavedAt = -Infinity;
    /** Monotonic time of the last increase of `evse/global_current` (flash). */
    this.flashAt = -Infinity;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** Monotonic time the last write left (a read begun before it is not applied). */
    this.lastSentAt = -Infinity;
    /** The command running: { role, seq, sent }. */
    this.command = undefined;
    /** A command sent and not confirmed: { role, until } (never "already so" meanwhile). */
    this.pending = undefined;
    /** Monotonic time the last start left (a stop sent within 90 s after it watches for it). */
    this.lastStartAt = -Infinity;
    /** Counts the stops: a command that arrived before the current count gives way. */
    this.protectSeq = 0;
    this.stops = [];
    this.stopWorker = undefined;
    /** The stop not seen applied, or undefined. */
    this.stopGuard = undefined;
    this.checking = false;
    /** The energy index guard of the created device, and its feature id. */
    this.indexGuard = undefined;
    this.indexFeature = undefined;
    this.savedIndex = undefined;
    this.keptWall = undefined;
    this.heldLogged = undefined;
    /** The first click of "Accept the held index": { at, listedAt, guard, listed }. */
    this.pendingAccept = undefined;
  }

  /** The monotonic clock (every in-memory time). */
  mono() {
    return this.monotonic();
  }

  /** The session clock (ms since epoch): never moved by a wall clock set by NTP. */
  sessionNow() {
    return this.wallStart + (this.monotonic() - this.monoStart);
  }

  /** Waits `ms`; ends at once when `signal` aborts (a stop takes the line). */
  sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const done = () => {
        this.timers.clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = this.timers.setTimeout(done, Math.max(0, ms));
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * `promise` raced against `ms` and `signal`: `{ done: true, value }`, or
   * `{ done: false }` when the time ran out or the line was taken. Never an
   * unbounded wait while the line is held (a hung disk never holds a stop back).
   */
  async bounded(promise, ms, signal) {
    let timer;
    let onAbort;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve({ done: false }), Math.max(0, ms));
      onAbort = () => resolve({ done: false });
      if (signal?.aborted) onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([
        promise.then(
          (value) => ({ done: true, value }),
          () => ({ done: true, value: undefined }),
        ),
        late,
      ]);
    } finally {
      this.timers.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // --- /data -------------------------------------------------------------------

  /** Loads /data once (the stop kept there belongs to the whole run). */
  loadMemory() {
    if (!this.memoryLoaded) {
      this.memoryLoaded = (async () => {
        let result;
        try {
          result = await this.store.load();
        } catch {
          result = { unreadable: true };
        }
        const now = this.now();
        const mono = this.mono();
        if (result?.unreadable) {
          this.memoryUnreadable = true;
          this.logger.warn('WARP: /data/warp-state.json cannot be read: it is never overwritten');
          this.memory = normalizeMemory(null, now);
          return;
        }
        this.memory = normalizeMemory(result?.data ?? null, now);
        // Waits kept as wall dates, turned into monotonic deadlines now.
        if (this.memory.pause) {
          this.pausedUntil = Math.max(this.pausedUntil, mono + (this.memory.pause.until - now));
        }
        if (this.memory.block) {
          this.blockedUntil = Math.max(this.blockedUntil, mono + (this.memory.block.until - now));
        }
        if (this.memory.flashAt !== null) {
          this.flashAt = Math.max(this.flashAt, mono - (now - this.memory.flashAt));
        }
      })();
    }
    return this.memoryLoaded;
  }

  async saveMemory() {
    if (this.memoryUnreadable) {
      return false;
    }
    try {
      await this.store.save(this.memory);
      return true;
    } catch (err) {
      this.logger.warn(`WARP: saving the state to /data failed: ${err.message}`);
      return false;
    }
  }

  /** The stop not seen applied, in /data (or none). */
  persistStop() {
    const g = this.stopGuard;
    const stop = g
      ? {
          host: g.target.host,
          port: g.target.port,
          since: g.since,
          written: g.written,
          resends: g.resends,
        }
      : null;
    if (JSON.stringify(stop) === JSON.stringify(this.memory.stop ?? null)) {
      return Promise.resolve(true);
    }
    this.memory.stop = stop;
    return this.saveMemory();
  }

  /**
   * At the start of the container, before the configuration is read: a stop
   * kept in /data (not seen applied before the restart) is sent again at
   * once to the address it was sent to, without a read first.
   */
  async boot() {
    await this.loadMemory();
    const kept = this.memory.stop;
    if (!kept || this.stopGuard) {
      return;
    }
    const target = { host: kept.host, port: kept.port };
    const guard = this.newStopGuard(target);
    guard.since = kept.since;
    // What /data says of it: written before, and the resends the charger accepted.
    guard.written = kept.written;
    guard.resends = kept.resends;
    this.stopGuard = guard;
    if (guard.written && guard.resends >= TIMINGS.stopResends) {
      // Held (sent 4 times without effect): checked only, never sent again by a restart.
      this.logger.warn('WARP: a stop held in /data is checked again');
      this.armStopCheck(0);
      return;
    }
    this.logger.warn('WARP: a stop kept in /data is sent again');
    this.queueStop({ target, received: this.mono(), fromBoot: true });
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `fresh`: started for a new address while running (a read may go at
   * once); otherwise (container start) the first read waits for the interval
   * after the last read kept in /data.
   */
  async start(raw = {}, { fresh = false } = {}) {
    this.stop();
    this.config = normalizeConfig(raw);
    const generation = this.generation;
    await this.charger.running;
    await this.loadMemory();
    if (generation !== this.generation) {
      return;
    }
    this.charger = freshCharger();
    this.client.reset();
    // The charger last read at this address: shown (offline) until it is read again.
    const kept = this.memory.target;
    if (this.config.address && sameAddress(kept, this.config.address) && kept.uid) {
      this.charger.uid = kept.uid;
    }
    this.indexGuard = undefined;
    this.indexFeature = undefined;
    this.savedIndex = undefined;
    this.pendingAccept = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (this.stopGuard) {
      // The configuration (and its credentials) is known now: the stop is checked at once.
      this.armStopCheck(0);
    }
    if (!this.config.address || this.config.badAuth) {
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status()[1], generation);
    if (generation !== this.generation) {
      return;
    }
    const wait = fresh ? 0 : this.firstWait();
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  /** The wait before the first read after a container start, from the time kept in /data. */
  firstWait() {
    if (this.memoryUnreadable) {
      // The time of the last read is unknown: a whole interval.
      return this.interval;
    }
    const stored = this.memory.lastAttemptAt;
    if (stored === null) {
      return 0;
    }
    this.lastAttemptAt = Math.max(this.lastAttemptAt, this.mono() - (this.now() - stored));
    // A read may have left up to a minute after the time kept (written at most once a minute).
    const due = stored + TIMINGS.attemptWriteEvery + this.interval;
    return Math.min(this.interval, Math.max(0, due - this.now()));
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    for (const handle of this.charger.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.charger.followUps.clear();
    // A read of this configuration ends (a stop or its check has its own target).
    if (this.lane.holder?.kind === 'read') {
      this.lane.holder.controller.abort();
    }
    this.publisher.stop();
  }

  /** The container stops: every timer (the stop is in /data), and /data written. */
  async shutdown() {
    this.stop();
    if (this.stopGuard?.timer) {
      this.timers.clearTimeout(this.stopGuard.timer);
      this.stopGuard.timer = undefined;
    }
    this.memory.lastAttemptAt = Number.isFinite(this.lastAttemptAt)
      ? this.now() - (this.mono() - this.lastAttemptAt)
      : this.memory.lastAttemptAt;
    await this.saveMemory();
  }

  clearTimer() {
    if (this.charger.timer) {
      this.timers.clearTimeout(this.charger.timer);
      this.charger.timer = undefined;
    }
  }

  /**
   * Connected to Gladys: reads the configuration, tried again every 30 s
   * while it fails (with a status), forever, then `connected`.
   */
  async onConnected(getConfig) {
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    // A configuration saved after this request left wins over its answer.
    const seq = this.configSeq;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      this.logger.warn(`WARP: reading the configuration failed: ${err.message}`);
      await this.loadMemory();
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnreadable);
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.onConnected(getConfig).catch(() => {});
      }, TIMINGS.configRetry);
      return;
    }
    await this.inOrder(() => this.connected(seq !== this.configSeq ? this.savedRaw : raw));
  }

  /** Configurations (read or saved) applied one at a time, in their order of arrival. */
  inOrder(fn) {
    const run = this.configChain.then(fn);
    this.configChain = run.catch(() => {});
    return run;
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badge), without reading the charger nor sending old values.
   */
  async connected(raw = {}) {
    this.configRead = true;
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.liftBlockOnNewCredentials(raw);
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    this.rescheduleOnNewInterval(previous);
    await this.publishAll();
  }

  /** Only a new address or new credentials restart (an interval only reschedules). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalidHost !== this.config.invalidHost ||
      next.credentialsInHost !== this.config.credentialsInHost ||
      next.https !== this.config.https ||
      next.badAuth !== this.config.badAuth ||
      credentialsKey(next) !== credentialsKey(this.config)
    );
  }

  /** New credentials saved (or given at a reconnection) lift a block at once. */
  async liftBlockOnNewCredentials(raw) {
    if (credentialsKey(normalizeConfig(raw)) !== credentialsKey(this.config) && this.memory.block) {
      this.memory.block = null;
      this.blockedUntil = -Infinity;
      await this.saveMemory();
    }
  }

  rescheduleOnNewInterval(previous) {
    const c = this.charger;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.config.address &&
      !this.config.badAuth &&
      !c.running &&
      c.online !== false &&
      c.timer
    ) {
      this.schedule(this.dueIn());
    }
  }

  /** The configuration saved: applied in order of arrival, the last one wins. */
  configUpdated(raw = {}) {
    this.configSeq += 1;
    this.savedRaw = raw;
    return this.inOrder(() => this.applyConfig(raw));
  }

  async applyConfig(raw) {
    this.configRead = true;
    await this.liftBlockOnNewCredentials(raw);
    if (!this.started || this.needsRestart(raw)) {
      this.started = true;
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.rescheduleOnNewInterval(previous);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(`WARP commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (
      this.config.language !== previous.language ||
      this.config.maxCurrent !== previous.maxCurrent
    ) {
      this.published = undefined;
    }
    await this.publishAll();
  }

  async setStatus(connected, message, generation = this.generation) {
    if (generation !== this.generation) {
      return;
    }
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Pauses and credentials ----------------------------------------------------

  get paused() {
    return this.mono() < this.pausedUntil;
  }

  get blocked() {
    return this.mono() < this.blockedUntil;
  }

  /** Credentials refused (or asked for): the tries are spaced (15 min, 1 h, 6 h), kept in /data. */
  async authFailed() {
    const failures = (this.memory.block?.failures ?? 0) + 1;
    const wait = TIMINGS.authBackoff[Math.min(failures - 1, TIMINGS.authBackoff.length - 1)];
    this.blockedUntil = this.mono() + wait;
    this.memory.block = { until: this.now() + wait, failures };
    await this.saveMemory();
    this.logger.warn(
      `WARP: ${this.config.auth ? 'credentials refused' : 'credentials asked for'}; next try in ${Math.round(wait / 60000)} min`,
    );
  }

  /** A 429 or a 5xx: every path waits but the stop, kept in /data. */
  async pause(err, reason = '429', wait = undefined) {
    const length =
      wait ??
      Math.min(
        TIMINGS.rateLimitMax,
        Math.max(TIMINGS.rateLimitMin, err?.retryAfter ?? TIMINGS.rateLimitDefault),
      );
    this.pausedUntil = Math.max(this.pausedUntil, this.mono() + length);
    this.memory.pause = { until: this.now() + (this.pausedUntil - this.mono()), reason };
    await this.saveMemory();
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The time until the next read may go (never sooner than the interval). */
  dueIn(mono = this.mono()) {
    return Math.max(0, this.lastAttemptAt + this.interval - mono);
  }

  /**
   * The next read: after a pause or a block (never sooner than the
   * interval), after its backoff, else the interval.
   */
  schedule(delay) {
    const c = this.charger;
    this.clearTimer();
    const mono = this.mono();
    let wait;
    if (this.paused) {
      wait = Math.max(this.pausedUntil - mono, this.interval);
    } else if (this.blocked) {
      wait = Math.max(this.blockedUntil - mono, this.interval);
    } else {
      wait = delay ?? (c.online === false ? c.wait : this.interval);
    }
    const generation = this.generation;
    c.timer = this.timers.setTimeout(
      () => {
        c.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch((err) => this.logger.error(`WARP refresh failed: ${err.message}`));
        }
      },
      Math.max(0, wait ?? this.interval),
    );
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const c = this.charger;
    if (!c.running) {
      c.running = this.run().finally(() => {
        c.running = undefined;
      });
    }
    return c.running;
  }

  /** The time of this read, in memory and (at most once a minute) in /data, BEFORE it. */
  async noteAttempt() {
    const mono = this.mono();
    this.lastAttemptAt = mono;
    if (mono - this.attemptSavedAt >= TIMINGS.attemptWriteEvery) {
      this.attemptSavedAt = mono;
      this.memory.lastAttemptAt = this.now();
      await this.saveMemory();
    }
  }

  async run() {
    const generation = this.generation;
    if (this.paused || this.blocked) {
      await this.updateStatus();
      this.schedule();
      return;
    }
    let delay;
    await this.noteAttempt();
    const startedAt = this.mono();
    try {
      const read = await this.readAll(generation);
      if (generation !== this.generation) {
        return;
      }
      if (startedAt <= this.lastSentAt) {
        // Begun before a write left: it may show the state before it.
        this.logger.debug('WARP: read begun before a write, not applied');
      } else {
        await this.applyRead(read, startedAt);
        await this.saveTarget();
        await this.evaluateIndex();
        if (this.memory.block) {
          this.memory.block = null;
          await this.saveMemory();
        }
        this.observeStop(read, startedAt);
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      if (err?.kind === ERROR_KINDS.ABORTED) {
        // The line was taken (a stop, a command): not a failure, nothing applied.
        this.logger.debug('WARP: read ended by a stop or a command');
      } else {
        delay = await this.failed(err);
      }
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /** One GET on the line (a turn of its own: a command or a stop may pass between two). */
  async read(topic, generation, parse) {
    const holder = await this.lane.acquire('read');
    try {
      if (generation !== this.generation) {
        throw new ChargerError(ERROR_KINDS.ABORTED, 'Configuration changed');
      }
      const data = await this.client.get(this.config.address, this.config.auth, topic, {
        timeoutMs: TIMINGS.readTimeout,
        signal: holder.signal,
      });
      return parse(data);
    } finally {
      holder.release();
    }
  }

  /** Whether a secondary topic is due now. */
  secondaryDue(name, mono) {
    const s = this.charger.secondary.get(name);
    return !s || mono >= s.nextAt;
  }

  /**
   * A secondary topic failed: tried again after twice the interval, doubling
   * up to 1 h (a 404: an hour: the firmware has no such module). A 401 there
   * while the core topics answered is "not read", never a refusal.
   */
  secondaryFailed(name, err, mono) {
    const s = this.charger.secondary.get(name) ?? { failures: 0 };
    s.failures += 1;
    const wait =
      err?.kind === ERROR_KINDS.HTTP && err.status === 404
        ? TIMINGS.secondaryMaxWait
        : Math.min(TIMINGS.secondaryMaxWait, this.interval * 2 ** s.failures);
    s.nextAt = mono + wait;
    s.reason = err?.kind === ERROR_KINDS.HTTP && err.status === 404 ? 'absent' : errorReason(err);
    this.charger.secondary.set(name, s);
    this.logger.debug(`WARP: ${name} not read (${s.reason})`);
  }

  /**
   * The core (`info/name`, `evse/state`, `evse/slots`), then the secondary
   * topics due. A 429 anywhere pauses everything; an abort ends the read.
   */
  async readAll(generation) {
    const c = this.charger;
    const get = (topic, parse) => this.read(topic, generation, parse);
    const name = await get(TOPICS.name, parseName);
    if (!name.charger) {
      throw new ChargerError(ERROR_KINDS.PROTOCOL, 'Not a WARP charger', { notCharger: true });
    }
    if (!name.uid) {
      throw new ChargerError(ERROR_KINDS.PROTOCOL, 'No uid', { noId: true });
    }
    const state = await get(TOPICS.state, parseState);
    const slots = await get(TOPICS.slots, parseSlots);
    const read = { name, state, slots, values: {}, failed: [] };
    const mono = this.mono();
    const slowDue = mono - c.slowAt >= TIMINGS.slowRefresh || c.uid !== name.uid;
    const secondary = async (key, fn) => {
      if (!this.secondaryDue(key, mono) && !(key === 'meterIds' && slowDue)) {
        read.failed.push(key);
        return;
      }
      try {
        read.values[key] = await fn();
        this.charger.secondary.delete(key);
      } catch (err) {
        // An abort ends the read; a 429 pauses everything (the charger asks it). Any
        // other failure (a 5xx, a 401 while the core answered, a 404, a bad
        // shape) leaves this topic unread, never the others.
        if (err?.kind === ERROR_KINDS.ABORTED || err?.kind === ERROR_KINDS.RATE_LIMITED) {
          throw err;
        }
        this.secondaryFailed(key, err, mono);
        read.failed.push(key);
      }
    };
    if (slowDue || c.firmware === undefined) {
      await secondary('version', () => get(TOPICS.version, parseVersion));
    }
    let ids = c.uid === name.uid ? c.meterIds : undefined;
    if (slowDue || ids === undefined) {
      await secondary('meterIds', () => get(TOPICS.meterIds, parseMeterIds));
      ids = read.values.meterIds ?? ids;
    }
    await secondary('meterValues', async () => {
      const values = await get(TOPICS.meterValues, parseMeterValues);
      if (ids && values.length !== ids.length && read.values.meterIds === undefined) {
        // The meter changed its values: its ids are read again before any value is used.
        ids = await get(TOPICS.meterIds, parseMeterIds);
        read.values.meterIds = ids;
      }
      return values;
    });
    read.ids = ids;
    await secondary('currentCharge', () => get(TOPICS.currentCharge, parseCurrentCharge));
    await secondary('setting', async () => {
      const external = await get(TOPICS.externalEnabled, parseEnabled);
      const ma = await get(external ? TOPICS.externalCurrent : TOPICS.globalCurrent, parseCurrent);
      return { source: external ? 'external' : 'global', ma };
    });
    await secondary('chargeMode', () => get(TOPICS.chargeMode, parseChargeMode));
    if (slowDue) {
      c.slowAt = mono;
    }
    return read;
  }

  /** A read answered: the charger as read (only what was read this time). */
  async applyRead(read, startedAt) {
    const c = this.charger;
    const { name, state, slots, values } = read;
    if (c.uid && c.uid !== name.uid) {
      // Another charger answers at this address: the old device is no longer read.
      this.logger.warn('WARP: another charger answers at this address');
      this.indexGuard = undefined;
      this.indexFeature = undefined;
      this.savedIndex = undefined;
      this.pendingAccept = undefined;
      c.meterIds = undefined;
      c.firmware = undefined;
    }
    c.online = true;
    c.failures = 0;
    c.wait = undefined;
    c.error = undefined;
    c.uid = name.uid;
    c.type = name.type;
    c.displayType = name.displayType;
    if (values.version !== undefined) c.firmware = values.version;
    if (values.meterIds !== undefined) c.meterIds = values.meterIds;
    c.state = state;
    c.slots = slots;
    const ids = read.ids;
    const meter = values.meterValues;
    c.power = meter ? meterValue(ids, meter, METER.POWER) : undefined;
    c.energy = meter ? meterValue(ids, meter, METER.ENERGY_IMPORT) : undefined;
    const session = values.currentCharge;
    c.sessionEnergy =
      session?.active && session.meterStart !== undefined && c.energy !== undefined
        ? Math.max(0, c.energy - session.meterStart)
        : undefined;
    c.setting = values.setting;
    c.chargeMode = values.chargeMode;
    c.failed = read.failed.filter((key) => SECONDARY.includes(key));
    c.readAt = startedAt;
  }

  /** Keeps in /data the address and uid of the charger read, when they changed. */
  async saveTarget() {
    const c = this.charger;
    const address = this.config.address;
    const kept = this.memory.target;
    if (!c.uid || (sameAddress(kept, address) && kept.uid === c.uid)) {
      return;
    }
    this.memory.target = { host: address.host, port: address.port, uid: c.uid };
    await this.saveMemory();
  }

  /** A failed read: the delay before the next one. */
  async failed(err) {
    const c = this.charger;
    const reason = errorReason(err);
    if (err.kind === ERROR_KINDS.AUTH) {
      // Not read until new credentials or the end of the block: offline.
      c.online = false;
      c.error = 'auth';
      await this.authFailed();
      return undefined;
    }
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      // The charger answers: the status shows the 429 pause.
      await this.pause(err, '429');
      this.logger.warn(`WARP: ${reason}, pause`);
      return undefined;
    }
    // Never read again sooner than the interval.
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(c.failures, TIMINGS.backoff.length - 1)],
    );
    c.failures += 1;
    c.online = false;
    c.wait = wait;
    c.error = err.notCharger ? 'not_charger' : err.noId ? 'no_id' : reason;
    c.redirect = err.redirect === true;
    if (err.kind === ERROR_KINDS.HTTP && err.status >= 500) {
      // A 5xx: a pause of the same length, kept in /data.
      await this.pause(err, '5xx', wait);
    }
    this.logger.warn(`WARP: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  pauseMessage() {
    if (!this.paused) {
      return undefined;
    }
    const wait = age(this.pausedUntil - this.mono());
    return this.memory.pause?.reason === '5xx' ? T.serverError(wait) : T.rateLimited(wait);
  }

  // --- Energy index ----------------------------------------------------------

  /** The created feature of the energy index of the charger read, else undefined. */
  indexFeatureOf() {
    const c = this.charger;
    if (!c.uid) {
      return undefined;
    }
    const id = chargerIds(this.gladys, c.uid).feature(FEATURES.TOTAL_ENERGY);
    for (const device of this.gladys.devices ?? []) {
      const feature = (device?.features ?? []).find((f) => f?.external_id === id);
      if (feature) {
        return feature;
      }
    }
    return undefined;
  }

  /**
   * The guard of the created index feature, from Gladys and /data, on the
   * session clock: their wall dates turned into session dates with the
   * offset of now, then bounded by the session clock (a date in the future
   * is now).
   */
  currentIndexGuard() {
    const feature = this.indexFeatureOf();
    if (!feature) {
      return undefined;
    }
    if (!this.indexGuard || this.indexFeature !== feature.external_id) {
      const saved =
        this.memory.index?.featureId === feature.external_id ? this.memory.index : undefined;
      const sessionNow = this.sessionNow();
      const offset = this.now() - sessionNow;
      const toSession = (ref) =>
        ref && Number.isFinite(ref.at)
          ? { ...ref, at: Math.min(ref.at - offset, sessionNow) }
          : ref;
      const kept = saved ? { last: toSession(saved.last), held: toSession(saved.held) } : undefined;
      this.indexGuard = new IndexGuard(toSession(lastValueOf(feature)), kept, sessionNow);
      this.indexFeature = feature.external_id;
      this.savedIndex = undefined;
      // The reference taken from /data keeps its wall date there while it is unchanged.
      const last = this.indexGuard.last;
      this.keptWall =
        last && kept?.last && last.value === kept.last.value && last.at === kept.last.at
          ? { value: last.value, at: last.at, wall: saved.last.at }
          : undefined;
    }
    return this.indexGuard;
  }

  /**
   * The energy index of the last read through the guard: what to publish
   * (the value, or the last one accepted while a value is held), kept in
   * /data when the guard changed. Nothing while the device is not created.
   */
  async evaluateIndex() {
    const c = this.charger;
    const guard = this.currentIndexGuard();
    if (!guard || c.energy === undefined) {
      c.indexValue = undefined;
      return;
    }
    const value = round3(c.energy);
    const plausible = guard.accept(value, this.sessionNow());
    c.indexValue = plausible ? value : guard.held ? guard.last?.value : undefined;
    const heldKey = guard.held ? `${guard.held.direction}:${guard.held.from}` : undefined;
    if (heldKey && heldKey !== this.heldLogged) {
      this.logger.warn(
        `WARP energy index ${guard.held.direction === 'down' ? 'drop' : 'jump'} held back: "Accept the held index" takes it`,
      );
    }
    this.heldLogged = heldKey;
    await this.saveIndex();
  }

  /**
   * Keeps the guard in /data when its reference, its value held or the
   * offset of the wall clock (to the minute) changed, as wall dates.
   */
  async saveIndex() {
    const state = this.indexGuard.state();
    const offset = this.now() - this.sessionNow();
    const kept = this.keptWall;
    const toWall = (ref) => {
      if (!ref || !Number.isFinite(ref.at)) return ref;
      if (ref === state.last && kept && ref.value === kept.value && ref.at === kept.at) {
        return { ...ref, at: kept.wall };
      }
      return { ...ref, at: ref.at + offset };
    };
    const key = JSON.stringify([
      this.indexFeature,
      state.last,
      Math.round(offset / 60_000),
      state.held && {
        direction: state.held.direction,
        from: state.held.from,
        threshold: state.held.threshold,
      },
    ]);
    if (key === this.savedIndex) {
      return;
    }
    this.memory.index = {
      featureId: this.indexFeature,
      last: toWall(state.last),
      held: toWall(state.held),
    };
    if (await this.saveMemory()) {
      this.savedIndex = key;
    }
  }

  /**
   * "Accept the held index", in two clicks: the first lists the value held
   * (nothing is accepted), the second, from 3 s to 5 min later, accepts it
   * only when the guard still holds that value, or, for a rise since, what
   * the charger may have drawn since the first click. The acceptance itself
   * stays bounded (src/guard.js). A save of the form never accepts.
   */
  async acceptHeldIndex() {
    const guard = this.currentIndexGuard();
    const held = guard?.held;
    const mono = this.mono();
    const now = this.sessionNow();
    const pending = this.pendingAccept;
    this.pendingAccept = undefined;
    const elapsed = pending ? mono - pending.at : undefined;
    if (!pending || elapsed > TIMINGS.acceptConfirmWithin || elapsed < TIMINGS.acceptConfirmAfter) {
      if (!held) {
        return T.accept.nothing;
      }
      const listed = { direction: held.direction, from: held.from, to: held.to };
      this.pendingAccept = { at: mono, listedAt: now, guard, listed };
      return T.accept.confirm(listed);
    }
    const { listed } = pending;
    const top = listed.to + (INDEX_MAX_KW * Math.max(0, now - pending.listedAt)) / 3_600_000;
    const same =
      held &&
      pending.guard === guard &&
      held.direction === listed.direction &&
      held.from === listed.from &&
      (held.direction === 'up'
        ? held.to >= listed.to && held.to <= top + INDEX_SLACK_KWH
        : held.to === listed.to);
    if (!same) {
      if (!held) return T.accept.nothing;
      return T.accept.changed;
    }
    const taken = guard.acceptHeld();
    this.logger.info(
      `WARP energy index ${taken.direction === 'down' ? 'drop' : 'jump'} accepted by the user`,
    );
    // Published at the next read (never sooner than the interval).
    return T.accept.done(taken);
  }

  // --- Status ----------------------------------------------------------------

  /** The message with what the user must see added: index held, stop held, values not read. */
  withNotes(message) {
    let text = message;
    const held = this.indexGuard?.held;
    if (held) {
      text = join(text, T.held(held));
    }
    const g = this.stopGuard;
    if (g && !g.applied) {
      text = join(text, g.resends >= TIMINGS.stopResends ? T.stopHeld : T.stopPending);
    }
    const failed = this.charger.failed ?? [];
    if (this.charger.online && failed.length > 0) {
      text = join(text, T.notRead(failed));
    }
    return text;
  }

  /** `[connected, message, plain]`; `plain`: the summary without "Connected". */
  status() {
    const c = this.charger;
    if (!this.config.address) {
      if (this.config.credentialsInHost) {
        return [false, T.hostCredentials];
      }
      if (this.config.https) {
        return [false, T.httpsNotSupported];
      }
      return [false, this.config.invalidHost ? T.invalidHost(this.config.invalidHost) : T.noHost];
    }
    if (this.config.badAuth) {
      return [false, this.config.badAuth === 'invalid' ? T.invalidAuth : T.incompleteAuth];
    }
    const pause = this.pauseMessage();
    if (pause) {
      return [false, this.withNotes(pause)];
    }
    if (this.blocked) {
      const wait = age(this.blockedUntil - this.mono());
      return [false, this.withNotes(this.config.auth ? T.authRefused(wait) : T.authAsked(wait))];
    }
    if (c.online === false) {
      const wait = age(c.wait ?? this.interval);
      let message;
      if (c.error === 'not_charger') message = T.notCharger;
      else if (c.error === 'no_id') message = T.noId;
      else if (c.redirect) message = T.redirected;
      else if (c.error === ERROR_KINDS.UNREACHABLE || c.error === ERROR_KINDS.TIMEOUT) {
        message = T.unreachable(addressKey(this.config.address), wait);
      } else message = T.failing(c.error ?? 'error', wait);
      return [false, this.withNotes(message)];
    }
    if (c.online === undefined || !c.state) {
      return [false, this.withNotes(T.connecting)];
    }
    let summary = T.summary({
      name: c.displayType ? `${c.displayType} (${c.uid})` : deviceName(c),
      state: statusText(c.state),
      power: c.power,
    });
    if (!this.config.allowCommands) {
      summary = join(summary, T.commandsOff);
    }
    summary = this.withNotes(summary);
    return [true, T.connected(summary), summary];
  }

  /** The connection status of the configuration screen. */
  async updateStatus(generation = this.generation) {
    const [connected, message, plain] = this.status();
    const orphans = this.orphans();
    if (orphans.length === 0) {
      await this.setStatus(connected, message, generation);
      return;
    }
    const names = orphans
      .map((uid) => {
        const device = (this.gladys.devices ?? []).find(
          (d) => d.external_id === chargerIds(this.gladys, uid).device,
        );
        return typeof device?.name === 'string' && device.name !== ''
          ? `${device.name.slice(0, 60)} (${uid})`
          : uid;
      })
      .join(', ');
    // Not connected: the message never starts with "Connected".
    await this.setStatus(false, join(plain ?? message, T.otherCharger(names)), generation);
  }

  // --- Gladys ----------------------------------------------------------------

  /** Whether the values of the last read may be sent as current (2 minutes at most). */
  fresh(mono = this.mono()) {
    return mono - this.charger.readAt <= TIMINGS.freshFor;
  }

  /** The charger to show and whether it is reachable; undefined while nothing is known. */
  shown() {
    const c = this.charger;
    if (c.uid && c.state && c.online !== false && !this.blocked) {
      return { charger: c, online: true };
    }
    if (c.uid && (c.online === false || this.blocked)) {
      return { charger: c, online: false };
    }
    return undefined;
  }

  /**
   * The uids of the devices created in Gladys that the charger read is not
   * (another charger at this address, or an address changed). Empty until a
   * read succeeded since the start (a charger down or blocked is not
   * "another charger"), unless there is no address at all.
   */
  orphans() {
    const c = this.charger;
    if (this.config.address && !this.config.badAuth && c.readAt === -Infinity) {
      return [];
    }
    const uids = [];
    for (const device of this.gladys.devices ?? []) {
      const uid = parseDeviceId(device?.external_id);
      if (uid && uid !== c.uid && chargerIds(this.gladys, uid).device === device.external_id) {
        uids.push(uid);
      }
    }
    return uids;
  }

  async publishAll() {
    const generation = this.generation;
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus(generation);
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishDevices() {
    const c = this.charger;
    if (!c.uid || !c.state || c.readAt === -Infinity) {
      return;
    }
    const devices = [
      buildDevice(this.gladys, c, {
        ceiling: this.config.maxCurrent,
        language: this.config.language,
      }),
    ];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /** The states to send: those of a fresh read only (offline: status and connector). */
  queueStates(created = this.createdFeatures()) {
    const push = (uid, charger, online) => {
      const states = deviceStates(chargerIds(this.gladys, uid), charger, {
        online,
        language: this.config.language,
        ceiling: this.config.maxCurrent,
        index: charger.indexValue,
      });
      for (const { device_feature_external_id: id, ...value } of states) {
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    };
    const shown = this.shown();
    if (shown && (!shown.online || this.fresh())) {
      push(shown.charger.uid, shown.charger, shown.online);
    }
    // A created device the charger read is not: unreachable, never left "charging".
    for (const uid of this.orphans()) {
      push(uid, {}, false);
    }
  }

  async publishBadge() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const entries = [];
    const shown = this.shown();
    const id = shown && chargerIds(this.gladys, shown.charger.uid).device;
    if (shown && created.has(id)) {
      entries.push({
        external_id: id,
        transport: shown.online ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    for (const uid of this.orphans()) {
      entries.push({
        external_id: chargerIds(this.gladys, uid).device,
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): its last values at once, if fresh. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    if (this.fresh()) {
      // The index of a device just created goes through its guard first.
      await this.evaluateIndex();
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  /** A device was deleted: its guard is dropped (a new device starts a new index). */
  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id !== 'string') {
      return;
    }
    this.publisher.forget(device.external_id);
    const owned = (id) => typeof id === 'string' && id.startsWith(`${device.external_id}:`);
    if (owned(this.indexFeature)) {
      this.indexGuard = undefined;
      this.indexFeature = undefined;
      this.savedIndex = undefined;
      this.pendingAccept = undefined;
      this.charger.indexValue = undefined;
    }
    if (owned(this.memory.index?.featureId)) {
      this.memory.index = null;
      await this.saveMemory();
    }
  }

  /** The Discovery tab asks for a scan: the device of the last read, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------

  /** Reads the charger now if the interval allows it, else the last status (never sooner). */
  async testConnection() {
    if (this.stopGuard) {
      // A stop kept (not sent, refused, not applied): checked and sent first, now.
      this.armStopCheck(0);
    }
    if (!this.config.address || this.config.badAuth || this.paused || this.blocked) {
      return this.status()[1];
    }
    const wait = this.dueIn();
    if (wait > 0 || this.charger.running) {
      await this.charger.running;
      const [, message] = this.status();
      return join(message, T.test.notSooner(age(wait)));
    }
    await this.tick();
    return this.status()[1];
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /**
   * The value of a command, strictly: null, '', ' ', true or 1.5 are never
   * read as a number. Throws a refusal when it is not valid.
   */
  commandValue(role, value) {
    if (role === FEATURES.START) {
      if (value === PRESSED || value === String(PRESSED)) {
        return PRESSED;
      }
      throw this.refusal(ERRORS.badButton);
    }
    const amps =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)
          ? Number(value.trim())
          : NaN;
    if (!Number.isInteger(amps)) {
      throw this.refusal(ERRORS.badCurrent);
    }
    return amps;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    if (target.role === FEATURES.STOP) {
      // Never held back: whatever the value, the option, a read or a command.
      return this.protect(received);
    }
    const wanted = this.commandValue(target.role, value);
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (this.command) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const entry = { role: target.role, seq: this.protectSeq, sent: false };
    this.command = entry;
    try {
      return await this.runCommand(target, wanted, received, entry);
    } finally {
      if (this.command === entry) {
        this.command = undefined;
      }
    }
  }

  /** The checks before any request of a command, and again right before each write. */
  checkCommand(generation, entry) {
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (generation !== this.generation || !this.config.address) {
      throw this.refusal(ERRORS.unknownCharger);
    }
    if (entry.seq !== this.protectSeq) {
      throw this.refusal(ERRORS.stopMeanwhile);
    }
    if (this.paused) {
      const wait = age(this.pausedUntil - this.mono());
      throw this.refusal(
        this.memory.pause?.reason === '5xx' ? ERRORS.pausedServer(wait) : ERRORS.paused(wait),
      );
    }
    if (this.blocked) {
      throw this.refusal(ERRORS.noCredentials);
    }
  }

  isPending(role) {
    return this.pending?.role === role && this.mono() < this.pending.until;
  }

  /**
   * The fresh read of a command, on the line it holds: the identity, the
   * state and the slots, and for the current the slot Gladys writes.
   */
  async freshRead(role, holder, until) {
    const options = () => ({
      timeoutMs: Math.max(
        TIMINGS.commandMinRequest,
        Math.min(TIMINGS.readTimeout, until - this.mono()),
      ),
      signal: holder.signal,
    });
    const get = async (topic, parse) => {
      if (this.mono() >= until) {
        throw new ChargerError(ERROR_KINDS.LATE, 'Fresh read too slow');
      }
      return parse(await this.client.get(this.config.address, this.config.auth, topic, options()));
    };
    const name = await get(TOPICS.name, parseName);
    const state = await get(TOPICS.state, parseState);
    const slots = await get(TOPICS.slots, parseSlots);
    const fresh = { name, state, slots };
    if (role === FEATURES.SET_CURRENT) {
      const external = await get(TOPICS.externalEnabled, parseEnabled);
      fresh.setting = {
        source: external ? 'external' : 'global',
        ma: await get(external ? TOPICS.externalCurrent : TOPICS.globalCurrent, parseCurrent),
      };
    }
    return fresh;
  }

  /**
   * What to write, from the fresh read: `{ topic, value, check, expect,
   * before, flash }`, or undefined when it is already so.
   */
  plan(role, wanted, fresh) {
    const { state, slots } = fresh;
    if (role === FEATURES.START) {
      const button = slots[SLOT.BUTTON];
      if (state.iec === undefined || button === undefined) {
        throw this.refusal(ERRORS.missing);
      }
      if (state.iec === 0) {
        throw this.refusal(ERRORS.noVehicle);
      }
      if (state.iec === 4 || state.charger === 'error' || (state.error ?? 1) !== 0) {
        throw this.refusal(ERRORS.fault);
      }
      // Never above the ceiling: the current the charger may give once started
      // (its settings, never a dynamic slot that may rise by itself).
      const cap = capFixed(slots);
      const { high } = currentBounds(slots, this.config.maxCurrent);
      if (cap === undefined || !cablesKnown(slots)) {
        throw this.refusal(ERRORS.missing);
      }
      if (cap > high * 1000) {
        throw this.refusal(ERRORS.aboveCeiling(Math.floor(cap / 1000), high));
      }
      if (button.maxMa === BUTTON_RELEASED_MA && !this.isPending(role)) {
        return undefined;
      }
      return {
        topic: TOPICS.start,
        value: null,
        check: 'slots',
        expect: (back) => back[SLOT.BUTTON]?.maxMa === BUTTON_RELEASED_MA,
        before: (back) => back[SLOT.BUTTON]?.maxMa === button.maxMa,
      };
    }
    if (!cablesKnown(slots)) {
      throw this.refusal(ERRORS.missing);
    }
    const { low, high } = currentBounds(slots, this.config.maxCurrent);
    if (wanted < low || wanted > high) {
      throw this.refusal(ERRORS.outOfBounds(low, high));
    }
    const { source, ma } = fresh.setting;
    const wantedMa = wanted * 1000;
    if (ma === wantedMa && !this.isPending(role)) {
      return undefined;
    }
    const topic = source === 'external' ? TOPICS.externalCurrent : TOPICS.globalCurrent;
    return {
      topic,
      value: { current: wantedMa },
      check: topic,
      expect: (back) => back === wantedMa,
      before: (back) => back === ma,
      // Kept in the flash of the charger: an increase at most once a minute.
      flash: source === 'global' && !(ma !== undefined && wantedMa < ma),
    };
  }

  async runCommand(target, wanted, received, entry) {
    const generation = this.generation;
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const { role } = target;
    this.checkCommand(generation, entry);
    if (!this.configRead) {
      throw this.refusal(ERRORS.notReadYet);
    }
    // The line, or nothing sent: a turn that never comes by 3.5 s is given up.
    const giveUp = new AbortController();
    const giveUpTimer = this.timers.setTimeout(
      () => giveUp.abort(),
      Math.max(0, sendBy - TIMINGS.commandMinRequest - this.mono()),
    );
    let holder;
    try {
      holder = await this.lane.acquire('command', { signal: giveUp.signal });
    } catch {
      throw this.refusal(ERRORS.tooSlow);
    } finally {
      this.timers.clearTimeout(giveUpTimer);
    }
    try {
      return await this.commandOnLine(target, wanted, entry, holder, {
        generation,
        sendBy,
        answerBy,
        role,
      });
    } finally {
      holder.release();
    }
  }

  async commandOnLine(target, wanted, entry, holder, { generation, sendBy, answerBy, role }) {
    const address = this.config.address;
    const auth = this.config.auth;
    let fresh;
    const readStart = this.mono();
    try {
      fresh = await this.freshRead(role, holder, sendBy - TIMINGS.commandMinRequest);
    } catch (err) {
      if (err.kind === ERROR_KINDS.RATE_LIMITED) {
        // The pause starts now; its save to /data is never awaited under the line.
        this.pause(err, '429').catch(() => {});
      }
      if (err.kind === ERROR_KINDS.ABORTED && entry.seq !== this.protectSeq) {
        throw this.refusal(ERRORS.stopMeanwhile);
      }
      throw this.refusal(
        err.kind === ERROR_KINDS.LATE ? ERRORS.tooSlow : ERRORS.unknownState(errorReason(err)),
      );
    }
    if (generation !== this.generation) {
      throw this.refusal(ERRORS.unknownCharger);
    }
    if (!fresh.name.charger || fresh.name.uid !== target.uid) {
      throw this.refusal(ERRORS.otherCharger);
    }
    if (readStart > this.lastSentAt) {
      this.applyFresh(fresh, readStart);
    }
    const plan = this.plan(role, wanted, fresh);
    if (!plan) {
      return undefined;
    }
    this.checkCommand(generation, entry);
    if (plan.flash) {
      const since = this.mono() - this.flashAt;
      if (since < TIMINGS.flashMinInterval) {
        throw this.refusal(ERRORS.tooOften(age(TIMINGS.flashMinInterval - since)));
      }
      // In /data before the first byte: a restart never writes the flash sooner.
      // The save runs against the send deadline and the stop: never an
      // unbounded wait under the line.
      const previous = this.memory.flashAt;
      this.memory.flashAt = this.now();
      const saved = await this.bounded(
        this.saveMemory(),
        sendBy - TIMINGS.commandMinRequest - this.mono(),
        holder.signal,
      );
      if (!saved.done || !saved.value) {
        this.memory.flashAt = previous;
        if (entry.seq !== this.protectSeq) {
          throw this.refusal(ERRORS.stopMeanwhile);
        }
        throw this.refusal(saved.done ? ERRORS.notSaved : ERRORS.notSavedInTime);
      }
      this.flashAt = this.mono();
    }
    if (this.mono() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    const options = (until) => ({
      timeoutMs: Math.max(TIMINGS.commandMinRequest, until - this.mono()),
      signal: holder.signal,
    });
    this.logger.info(`WARP: ${role}`);
    try {
      await this.client.put(address, auth, plan.topic, plan.value, {
        ...options(answerBy - TIMINGS.applyWait),
        beforeSend: () => {
          // The option, the configuration and the stops checked again right before the byte.
          this.checkCommand(generation, entry);
          if (this.mono() > sendBy) {
            throw this.refusal(ERRORS.tooSlow);
          }
          entry.sent = true;
          this.lastSentAt = this.mono();
          if (role === FEATURES.START) {
            this.lastStartAt = this.lastSentAt;
          }
        },
      });
    } catch (err) {
      return this.commandFailed(err, entry, role);
    }
    if (role === FEATURES.START && this.stopGuard) {
      // A newer start clicked with the option and accepted (2xx): the stop before it is let go.
      this.dropStopGuard('newer start');
    }
    // The read back alone confirms it.
    await this.sleep(
      Math.min(TIMINGS.applyWait, answerBy - TIMINGS.commandMinRequest - this.mono()),
      holder.signal,
    );
    let back;
    try {
      const raw = await this.client.get(
        address,
        auth,
        plan.check === 'slots' ? TOPICS.slots : plan.check,
        {
          ...options(answerBy),
        },
      );
      back = plan.check === 'slots' ? parseSlots(raw) : parseCurrent(raw);
    } catch (err) {
      this.markPending(role);
      this.followUp();
      throw this.refusal(ERRORS.sentUnconfirmed(errorReason(err)));
    }
    this.followUp();
    if (plan.expect(back)) {
      this.pending = undefined;
      this.logger.info(`WARP: ${role} confirmed by the charger`);
      return undefined;
    }
    this.markPending(role);
    throw this.refusal(plan.before(back) ? ERRORS.notApplied : ERRORS.sentDiffers);
  }

  markPending(role) {
    this.pending = { role, until: this.mono() + TIMINGS.pendingFor };
  }

  /** A write that failed: never "not sent" once a byte may have left. */
  commandFailed(err, entry, role) {
    const reason = errorReason(err);
    this.logger.warn(`WARP: ${role} failed (${reason})`);
    if (!entry.sent) {
      if (err.cause instanceof Error && err.kind === ERROR_KINDS.YIELDED) {
        // A refusal of beforeSend (option off, a stop, too late): its own words.
        throw err.cause;
      }
      if (err.kind === ERROR_KINDS.ABORTED && entry.seq !== this.protectSeq) {
        throw this.refusal(ERRORS.stopMeanwhile);
      }
      throw this.refusal(ERRORS.notSent(reason));
    }
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      this.pause(err, '429').catch(() => {});
    }
    if (
      (err.kind === ERROR_KINDS.HTTP && err.status >= 400 && err.status < 500) ||
      err.kind === ERROR_KINDS.AUTH ||
      err.kind === ERROR_KINDS.RATE_LIMITED
    ) {
      // Answered with a refusal: not applied.
      this.followUp();
      throw this.refusal(ERRORS.refused(reason));
    }
    // A 5xx, a silence, a cut: it may have reached the charger.
    this.markPending(role);
    this.followUp();
    throw this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  /** The fresh read of a command, kept in memory and shown in the background. */
  applyFresh(fresh, readStart) {
    const c = this.charger;
    if (c.uid !== fresh.name.uid || c.readAt === -Infinity) {
      return;
    }
    c.state = fresh.state;
    c.slots = fresh.slots;
    if (fresh.setting) {
      c.setting = fresh.setting;
    }
    this.observeStop(fresh, readStart);
    this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
  }

  /**
   * Spaced reads after a command: its effect, then a check (each a new read).
   * The reads of an earlier command not done yet are replaced.
   */
  followUp() {
    const generation = this.generation;
    const c = this.charger;
    for (const handle of c.followUps) {
      this.timers.clearTimeout(handle);
    }
    c.followUps.clear();
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        c.followUps.delete(handle);
        if (generation === this.generation && !this.paused && !this.blocked) {
          Promise.resolve(c.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('WARP refresh failed'));
        }
      }, delay);
      c.followUps.add(handle);
    }
  }

  // --- The stop (protective) ---------------------------------------------------

  /** Where a stop goes: the configured address, else the last one read (in /data). */
  stopTarget() {
    if (this.config.address) {
      return { host: this.config.address.host, port: this.config.address.port };
    }
    const kept = this.memory.target;
    return kept ? { host: kept.host, port: kept.port } : undefined;
  }

  /** The credentials of a target: those of the configuration for its address only. */
  authFor(target) {
    return sameAddress(target, this.config.address) ? this.config.auth : undefined;
  }

  /**
   * The stop clicked: queued before anything (it ends a read or a command
   * on the line), answered by 4.3 s after the click.
   */
  async protect(received) {
    // Every command that arrived before this stop and has not left gives way.
    this.protectSeq += 1;
    // /data holds the address of the last read: known even before the
    // configuration (a hung disk never holds the stop back: 200 ms at most).
    await this.bounded(this.loadMemory(), TIMINGS.stopSaveWait);
    const target = this.stopTarget();
    if (!target) {
      throw this.refusal(ERRORS.noAddress);
    }
    const job = this.queueStop({ target, received });
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let timer;
    const outcome = await new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      job.done.then(resolve);
    });
    this.timers.clearTimeout(timer);
    if (outcome.late) {
      throw this.refusal(job.state.written ? ERRORS.stopUnconfirmed : ERRORS.stopPending);
    }
    if (outcome.error) {
      throw outcome.error;
    }
    return undefined;
  }

  /** Queues a stop, in the order of the clicks; a click for the same target still waiting is joined. */
  queueStop({ target, received, fromBoot = false }) {
    let job = this.stops.find((j) => !j.running && sameAddress(j.target, target));
    if (job) {
      return job;
    }
    job = { target, received, fromBoot, state: { written: false }, running: false };
    job.done = new Promise((resolve) => {
      job.resolve = resolve;
    });
    this.stops.push(job);
    // Whatever holds the line ends when the stop asks for it (src/lane.js aborts it).
    this.runStops();
    return job;
  }

  runStops() {
    if (this.stopWorker) {
      return;
    }
    this.stopWorker = (async () => {
      try {
        while (this.stops.length > 0) {
          const job = this.stops[0];
          job.running = true;
          try {
            await this.sendStop(job);
          } catch (err) {
            this.logger.warn(`WARP: stop failed: ${err.message}`);
            job.resolve({ error: this.refusal(ERRORS.stopPending) });
          }
          this.stops.shift();
        }
      } finally {
        this.stopWorker = undefined;
      }
    })();
  }

  newStopGuard(target) {
    return {
      target,
      since: this.now(),
      written: false,
      sentAt: undefined,
      resends: 0,
      /** Seen applied by the last read (a late start may still undo it). */
      applied: false,
      /** Until then, a start that left before the stop may still land: watched. */
      watchUntil: -Infinity,
      timer: undefined,
    };
  }

  /**
   * What a read says of the stop: 'done' (the button slot at 0, or no
   * vehicle: nothing charges), 'watch' (applied, but a start sent less than
   * 90 s before the stop may still land: kept and read again), 'wait' (read
   * too soon after the stop left),
   * 'resend' (the charge still allowed, or nothing readable: sent again, in
   * doubt), 'hold' (sent again 3 times without effect: held, said in the
   * status, no more writes until a new click).
   */
  decideStop(guard, read, readStartedAt) {
    const button = read?.slots?.[SLOT.BUTTON];
    if (read?.state?.iec === 0 || button?.maxMa === 0) {
      guard.applied = true;
      return this.mono() < guard.watchUntil ? 'watch' : 'done';
    }
    guard.applied = false;
    if (!guard.written) {
      return 'resend';
    }
    if (guard.sentAt !== undefined && readStartedAt < guard.sentAt + TIMINGS.stopApplyDelay) {
      return 'wait';
    }
    return guard.resends >= TIMINGS.stopResends ? 'hold' : 'resend';
  }

  /** A read (poll or command) seen by the stop not applied: applied, or checked now. */
  observeStop(read, startedAt) {
    const guard = this.stopGuard;
    if (!guard || !sameAddress(guard.target, this.config.address)) {
      return;
    }
    const decision = this.decideStop(guard, read, startedAt);
    if (decision === 'done') {
      this.dropStopGuard('applied');
    } else if (decision === 'resend' && !this.checking) {
      this.armStopCheck(0);
    }
  }

  /**
   * One stop: `evse/stop_charging` without a read first, then the read back
   * that alone confirms it. Unreachable, cut, silent or a 5xx: tried again
   * every 250 ms until 3 s after the click (the write is idempotent). Not
   * confirmed: kept (in /data) and checked every 15 s.
   */
  async sendStop(job) {
    const { target, state } = job;
    const retryUntil = Math.max(job.received, this.mono()) + TIMINGS.stopRetryFor;
    if (!this.stopGuard || !sameAddress(this.stopGuard.target, target)) {
      if (this.stopGuard) this.dropStopGuard('a stop to another address');
      this.stopGuard = this.newStopGuard(target);
    }
    const guard = this.stopGuard;
    if (!job.fromBoot) {
      guard.since = this.now();
      guard.resends = 0;
    }
    // A start that left less than 90 s before this click may still land: watched,
    // even when no byte of this stop leaves (the charge read stopped meanwhile).
    guard.watchUntil = Math.max(guard.watchUntil, this.lastStartAt + TIMINGS.pendingFor);
    // In /data before the first byte, so a restart sends it again; a save that
    // fails or hangs never holds the stop back (200 ms at most).
    let saveTimer;
    await Promise.race([
      this.persistStop().catch(() => false),
      new Promise((resolve) => {
        saveTimer = this.timers.setTimeout(resolve, TIMINGS.stopSaveWait);
      }),
    ]);
    this.timers.clearTimeout(saveTimer);
    let back;
    let failure;
    // A restart sending a stop already written before: a resend once the charger accepts it.
    const resendOnBoot = job.fromBoot && guard.written;
    this.logger.info('WARP: stop');
    for (;;) {
      const holder = await this.lane.acquire('stop');
      const auth = this.authFor(target);
      try {
        const timeoutMs = Math.max(TIMINGS.stopRetry, retryUntil - this.mono());
        await this.client.put(target, auth, TOPICS.stop, null, {
          timeoutMs,
          signal: holder.signal,
          beforeSend: () => {
            state.written = true;
            const at = this.mono();
            this.lastSentAt = at;
            if (this.stopGuard === guard) {
              guard.written = true;
              guard.sentAt = at;
              // A start that left shortly before may land after this stop.
              guard.watchUntil = Math.max(guard.watchUntil, this.lastStartAt + TIMINGS.pendingFor);
            }
          },
        });
        failure = undefined;
        if (resendOnBoot && this.stopGuard === guard) {
          guard.resends += 1;
        }
        // Read back once the controller had time to apply it (within the ack budget).
        await this.sleep(
          Math.min(TIMINGS.applyWait, job.received + TIMINGS.commandAnswerBy - 600 - this.mono()),
        );
        try {
          back = await this.readStopState(
            target,
            auth,
            holder,
            job.received + TIMINGS.commandAnswerBy,
          );
        } catch (err) {
          this.logger.debug(`WARP: read back of the stop failed (${errorReason(err)})`);
        }
        break;
      } catch (err) {
        failure = err;
        this.noteStopRefused(guard, err);
      } finally {
        holder.release();
      }
      const again =
        [
          ERROR_KINDS.UNREACHABLE,
          ERROR_KINDS.TIMEOUT,
          ERROR_KINDS.ABORTED,
          ERROR_KINDS.PROTOCOL,
        ].includes(failure.kind) ||
        (failure.kind === ERROR_KINDS.HTTP && failure.status >= 500) ||
        failure.kind === ERROR_KINDS.RATE_LIMITED;
      if (!again || this.mono() + TIMINGS.stopRetry >= retryUntil) {
        break;
      }
      await this.sleep(TIMINGS.stopRetry);
    }
    const decision = back === undefined ? undefined : this.decideStop(guard, back, Infinity);
    const confirmed = decision === 'done' || decision === 'watch';
    if (this.stopGuard === guard) {
      if (decision === 'done') {
        this.dropStopGuard('applied');
      } else if (decision === 'watch') {
        await this.persistStop();
        this.armStopCheck(this.watchDelay(guard));
      } else {
        await this.persistStop();
        this.armStopCheck();
      }
    }
    if (state.written) {
      this.followUp();
    }
    let result;
    if (confirmed) {
      this.logger.info('WARP: stop confirmed by the charger');
      result = {};
    } else if (failure) {
      const reason = errorReason(failure);
      this.logger.warn(`WARP: stop failed (${reason})`);
      if (!state.written) {
        result = { error: this.refusal(ERRORS.stopNotSent(reason)) };
      } else if (failure.kind === ERROR_KINDS.AUTH) {
        result = { error: this.refusal(ERRORS.stopRefused(reason)) };
      } else {
        result = { error: this.refusal(ERRORS.sentUnconfirmed(reason)) };
      }
    } else {
      result = { error: this.refusal(back ? ERRORS.stopNotApplied : ERRORS.stopUnconfirmed) };
    }
    this.updateStatus().catch(() => {});
    job.resolve(result);
  }

  /** `evse/state` and `evse/slots` on the line held, within `until`. */
  async readStopState(target, auth, holder, until) {
    const options = () => ({
      timeoutMs: Math.max(TIMINGS.commandMinRequest, until - this.mono()),
      signal: holder.signal,
    });
    const state = parseState(await this.client.get(target, auth, TOPICS.state, options()));
    const slots = parseSlots(await this.client.get(target, auth, TOPICS.slots, options()));
    return { state, slots };
  }

  /** Whether a click or a command waits or runs: a check gives way to them. */
  checkMustYield() {
    return this.stops.length > 0 || Boolean(this.stopWorker) || Boolean(this.command);
  }

  /**
   * The periodic check of the stop: reads the state and the slots, then sends
   * the stop again only when `decideStop` says so. It gives its turn up to a
   * click or a command (tried again a second later), and checks once more
   * right before its write.
   */
  async runCheck() {
    const guard = this.stopGuard;
    if (!guard) return;
    if (this.checkMustYield() || this.checking) {
      this.armStopCheck(SECOND);
      return;
    }
    this.checking = true;
    let decision;
    let written = false;
    const target = guard.target;
    const auth = this.authFor(target);
    let holder;
    try {
      // Every exit of the check ends below: let go on 'done', /data, the next check armed.
      await (async () => {
        holder = await this.lane.acquire('check');
        if (this.checkMustYield() || this.stopGuard !== guard) {
          decision = 'yield';
          return;
        }
        const startedAt = this.mono();
        let read;
        try {
          read = await this.readStopState(target, auth, holder, this.mono() + TIMINGS.readTimeout);
        } catch (err) {
          if (err.kind === ERROR_KINDS.ABORTED) throw err;
          // Nothing readable: sent again, in doubt (the write is the stop).
          read = undefined;
        }
        if (this.stopGuard !== guard) return;
        decision = this.decideStop(guard, read, startedAt);
        if (decision !== 'resend') return;
        const wasWritten = guard.written;
        await this.client.put(target, auth, TOPICS.stop, null, {
          timeoutMs: TIMINGS.readTimeout,
          signal: holder.signal,
          beforeSend: () => {
            if (this.checkMustYield() || this.stopGuard !== guard) {
              throw new Error('a newer click or command');
            }
            this.logger.warn('WARP: the charge is still allowed after a stop: stop sent again');
            written = true;
            guard.written = true;
            guard.sentAt = this.mono();
            guard.watchUntil = Math.max(guard.watchUntil, this.lastStartAt + TIMINGS.pendingFor);
            this.lastSentAt = guard.sentAt;
          },
        });
        // Accepted by the charger: a resend (a refusal, a 401 or a silence is not one).
        if (wasWritten) {
          guard.resends += 1;
        }
        // Read back once the controller had time to apply it.
        await this.sleep(TIMINGS.applyWait, holder.signal);
        if (this.stopGuard !== guard) return;
        try {
          const back = await this.readStopState(
            target,
            auth,
            holder,
            this.mono() + TIMINGS.readTimeout,
          );
          const after = this.decideStop(guard, back, Infinity);
          if (after === 'done' || after === 'watch') decision = after;
        } catch (err) {
          if (err.kind === ERROR_KINDS.ABORTED) throw err;
        }
      })();
    } catch (err) {
      if (err?.kind !== ERROR_KINDS.YIELDED && err?.kind !== ERROR_KINDS.ABORTED) {
        this.logger.warn(`WARP: check of the stop failed (${errorReason(err)})`);
      }
      this.noteStopRefused(guard, err);
    } finally {
      holder?.release();
      this.checking = false;
    }
    if (this.stopGuard !== guard) return;
    if (written) {
      this.followUp();
    }
    if (decision === 'done') {
      this.dropStopGuard('applied');
      return;
    }
    // Armed before /data is written (a hung disk never stops the checks).
    let delay;
    if (decision === 'yield') delay = SECOND;
    else if (decision === 'watch') delay = this.watchDelay(guard);
    else if (decision === 'wait' && guard.sentAt !== undefined) {
      delay = Math.max(0, guard.sentAt + TIMINGS.stopApplyDelay - this.mono());
    }
    this.armStopCheck(delay);
    this.persistStop().catch(() => {});
    this.updateStatus().catch(() => {});
  }

  /**
   * A stop answered with a refusal (401, a 4xx): not applied, so a read
   * right after it does not wait for it (`decideStop` 'wait').
   */
  noteStopRefused(guard, err) {
    if (err?.kind === ERROR_KINDS.AUTH || (err?.kind === ERROR_KINDS.HTTP && err.status < 500)) {
      guard.sentAt = undefined;
    }
  }

  /** The next read of a stop watched for a late start: 15 s at most, the end of the watch at least. */
  watchDelay(guard) {
    return Math.max(0, Math.min(TIMINGS.stopCheck, guard.watchUntil - this.mono() + 1));
  }

  dropStopGuard(reason) {
    const guard = this.stopGuard;
    if (!guard) return;
    if (guard.timer) this.timers.clearTimeout(guard.timer);
    this.stopGuard = undefined;
    this.logger.info(`WARP: stop let go (${reason})`);
    this.persistStop().catch(() => {});
    this.updateStatus().catch(() => {});
  }

  /** The next check of the stop: every 15 s, whatever the interval, the failures or a pause. */
  armStopCheck(delay = TIMINGS.stopCheck) {
    const guard = this.stopGuard;
    if (!guard) return;
    const dueAt = this.mono() + delay;
    if (guard.timer) {
      // A check already due sooner (the configuration just arrived) is never pushed back.
      if (guard.dueAt <= dueAt) return;
      this.timers.clearTimeout(guard.timer);
    }
    guard.dueAt = dueAt;
    guard.timer = this.timers.setTimeout(() => {
      guard.timer = undefined;
      if (this.stopGuard !== guard) return;
      this.runCheck().catch((err) => this.logger.warn(`WARP: check: ${err.message}`));
    }, delay);
  }
}
