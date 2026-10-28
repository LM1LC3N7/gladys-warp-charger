// -----------------------------------------------------------------------------
// WARP charger constants, manifest keys, limits and timings.
//
// A Tinkerforge WARP charger (WARP1 to WARP4, firmware 2.x) answers the HTTP
// API documented at docs.warp-charger.com (Interfaces, MQTT/HTTP API
// reference), the one its own web interface uses, on port 80:
//   - `GET <topic>` reads a state as JSON, `PUT <topic>` writes it (the
//     documentation's `curl -d`, POST and PUT are both accepted);
//   - optional Digest access authentication (RFC 2617, realm `esp32-lib`)
//     when users are configured on the charger: a 401 without it.
// Only the topics below are read or written; their meaning and units come
// from that reference (and the MeterValueID table of the firmware), checked
// against HomeAssistant-Tinkerforge-Warp-Wallbox-Custom-Component 2.0.2 (MIT).
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 80;

/** The topics read (GET) and written (PUT). Never any other. */
export const TOPICS = {
  name: '/info/name',
  version: '/info/version',
  state: '/evse/state',
  slots: '/evse/slots',
  globalCurrent: '/evse/global_current',
  externalEnabled: '/evse/external_enabled',
  externalCurrent: '/evse/external_current',
  meterIds: '/meters/0/value_ids',
  meterValues: '/meters/0/values',
  currentCharge: '/charge_tracker/current_charge',
  chargeMode: '/power_manager/charge_mode',
  start: '/evse/start_charging',
  stop: '/evse/stop_charging',
};

/** The device types `info/name` gives for a charger (`wem`, the Energy Manager, is not one). */
export const CHARGER_TYPES = new Set(['warp', 'warp2', 'warp3', 'warp4']);

/** The charging slots of `evse/slots` (esp32-firmware evse_common.h). */
export const SLOT = {
  INCOMING_CABLE: 0,
  OUTGOING_CABLE: 1,
  /** The start/stop button: `evse/start_charging` sets it to 32 A, `evse/stop_charging` to 0. */
  BUTTON: 4,
  /** `evse/global_current`, the charging current of the web interface (kept in flash). */
  GLOBAL: 5,
  /** `evse/external_current`, the external control (when `evse/external_enabled`). */
  EXTERNAL: 8,
};

/** What `evse/start_charging` writes in the button slot (mA). */
export const BUTTON_RELEASED_MA = 32_000;

/** MeterValueIDs (esp32-firmware meters/meter_value_id.csv). */
export const METER = {
  /** Active power, sum of the phases, draw minus feed, W. */
  POWER: 74,
  /** Active energy drawn, sum of the phases, since manufacturing, kWh. */
  ENERGY_IMPORT: 209,
};

/** `evse/state` charger_state (processed by the charge controller). */
export const CHARGER_STATES = {
  0: 'not_connected',
  1: 'waiting',
  2: 'ready',
  3: 'charging',
  4: 'error',
};

/** `power_manager/charge_mode` (esp32-firmware ConfigChargeMode; 4 "default" is a resolver). */
export const CHARGE_MODES = {
  0: 'fast',
  1: 'off',
  2: 'pv',
  3: 'min_pv',
  5: 'min',
  6: 'eco',
  7: 'eco_pv',
  8: 'eco_min',
  9: 'eco_min_pv',
};

/**
 * The charging current, in whole amperes: never below 6 A (IEC 61851, the
 * firmware's lowest), never above the ceiling of the configuration (16 A by
 * default, 32 A at most, the most a WARP gives) nor the cable limits read.
 */
export const CURRENT = {
  min: 6,
  max: 32,
  defaultCeiling: 16,
};

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  STATUS: 'status',
  CONNECTOR: 'connector-status',
  CHARGING_STATE: 'charging-state',
  PLUGGED: 'plugged',
  POWER: 'power',
  ALLOWED_CURRENT: 'allowed-current',
  SESSION_ENERGY: 'session-energy',
  TOTAL_ENERGY: 'total-energy',
  CHARGE_MODE: 'charge-mode',
  ERROR: 'error',
  START: 'start-charge',
  STOP: 'stop-charge',
  SET_CURRENT: 'set-current',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  ACCEPT_HELD_INDEX: 'accept_held_index',
};

/** The value a `button/push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 10,
  max: 600,
  default: 30,
};

/**
 * The energy index guard (src/guard.js): the most a charger may draw on
 * average between two reads (22 kW three-phase), and the kWh always accepted
 * on top (rounding, a late read).
 */
export const INDEX_MAX_KW = 25;
export const INDEX_SLACK_KWH = 0.5;

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** The largest answer read (meters/0/values is under 2 KB): cut beyond. */
  responseBytes: 16 * 1024,
  /** Longest text kept from an answer (display type, firmware). */
  textLength: 60,
  /** User name and password of the web interface: printable ASCII, bounded. */
  secretMin: 1,
  secretMax: 128,
  /** The most meter values read. */
  meterValues: 128,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request of the polling (a LAN charger answers in well under 1 s). */
  readTimeout: 4 * SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** 429: Retry-After bounded to 1 min .. 6 h, 5 min without; a 5xx pauses as a failed read. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 5 * MINUTE,
  /** Credentials refused: new tries 15 min, 1 h, then every 6 h (kept in /data). */
  authBackoff: [15 * MINUTE, HOUR, 6 * HOUR],
  /** A secondary topic that fails: tried again after twice the interval, doubling up to 1 h. */
  secondaryMaxWait: HOUR,
  /** `info/version` and `meters/0/value_ids`: at the start, then every hour (or when needed). */
  slowRefresh: HOUR,
  /** The time of the last read is written to /data at most this often, before the read. */
  attemptWriteEvery: MINUTE,
  /** `getConfig()` failed: tried again this often, forever. */
  configRetry: 30 * SECOND,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** Values older than this are never sent as new (reconnection, device created). */
  freshFor: 2 * MINUTE,
  /** "Accept the held index": the second click 3 s to 5 min after the first. */
  acceptConfirmAfter: 3 * SECOND,
  acceptConfirmWithin: 5 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the first write must leave by
   * 3.5 s after the click, or the command is refused unsent; the ack comes
   * by 4.3 s, after which the command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The least time a request of a command gets. */
  commandMinRequest: 250,
  /** After a write, the read back waits this long (the controller applies a slot within ~250 ms). */
  applyWait: 600,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A command not confirmed: a new one is always sent for this long (never "already so"). */
  pendingFor: 90 * SECOND,
  /** An increase of `evse/global_current` (kept in flash) at most once a minute; a decrease never limited. */
  flashMinInterval: MINUTE,
  /** The stop: tried again every 250 ms until 3 s after the click. */
  stopRetry: 250,
  stopRetryFor: 3_000,
  /** The stop waits at most this long for /data before its first byte (a failing disk never holds it). */
  stopSaveWait: 200,
  /** A stop not seen applied: checked every 15 s. */
  stopCheck: 15 * SECOND,
  /** A read that started this soon after the stop left may not show it yet. */
  stopApplyDelay: 2 * SECOND,
  /** A stop not applied is written again at most 3 times (then held, said in the status). */
  stopResends: 3,
};
