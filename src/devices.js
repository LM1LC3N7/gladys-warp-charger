// -----------------------------------------------------------------------------
// The charger -> one Gladys device and its states (pure).
//
// `ext:<selector>:warp:<uid>`: one device per charger, keyed by the UID of
// its ESP brick (`uid` of `info/name`, base58, case kept), never by its IP
// address (it may change) nor its host name (the user sets it). The feature
// roles (the last part of their external ids) are published forever: never
// rename them. Every role is always built, so a republished device never
// loses a feature.
//
// No switch, no writable binary: a "turn everything off" (Google Home,
// Alexa, HomeKit, MCP, `switch.*` scenes) must never reach a charge command.
// Starting and stopping are two `button/push` features, the charging current
// a `text/select` of the whole amperes from 6 A to the ceiling. Start and the
// current refuse unless the configuration allows the commands; the stop is
// never held back (src/app.js).
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): W and kWh on `energy-sensor`, A and kWh
// on `electrical-vehicle-charge`. The energy drawn since the charger was
// made is a cumulative counter: an `energy-sensor/index` the core turns into
// consumption, so it only ever goes through the guard of src/guard.js (never
// 0, jumps and drops held). The energy of the session is a plain sensor. The
// power is "draw minus feed" (MeterValueID 74): a signed sensor.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { CURRENT, FEATURES } from './constants.js';
import { FEATURE_NAMES, MODE_NAMES, STATE_NAMES, word } from './i18n.js';
import { hardwareMax } from './warp/model.js';

/** CHARGING_STATION_CONNECTOR_STATUS of the core (server/utils/constants.js). */
export const CONNECTOR_STATUS = {
  AVAILABLE: 0,
  OCCUPIED: 1,
  RESERVED: 2,
  UNAVAILABLE: 3,
  FAULTED: 4,
};

/** CHARGING_STATION_CHARGING_STATE of the core (OCPP 2.0.1 chargingState). */
export const CHARGING_STATE = {
  CHARGING: 0,
  EV_CONNECTED: 1,
  PAUSED_BY_VEHICLE: 2,
  PAUSED_BY_CHARGER: 3,
  IDLE: 4,
  DISCHARGING: 5,
};

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0 });

/** The features, by role, in display order (set-current gets its options in buildDevice). */
export const DEFINITIONS = {
  [FEATURES.STATUS]: text,
  [FEATURES.CONNECTOR]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CONNECTOR_STATUS,
    min: 0,
    max: 4,
  }),
  [FEATURES.CHARGING_STATE]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CHARGING_STATE,
    min: 0,
    max: 5,
  }),
  [FEATURES.PLUGGED]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.PLUGGED,
    min: 0,
    max: 1,
  }),
  [FEATURES.POWER]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.POWER,
    unit: U.WATT,
    min: -50_000,
    max: 50_000,
  }),
  [FEATURES.ALLOWED_CURRENT]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.TARGET_CURRENT,
    unit: U.AMPERE,
    min: 0,
    max: 32,
  }),
  [FEATURES.SESSION_ENERGY]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.LAST_CHARGE_ENERGY_ADDED,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 1000,
  }),
  [FEATURES.TOTAL_ENERGY]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.INDEX,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 10_000_000,
  }),
  [FEATURES.CHARGE_MODE]: text,
  [FEATURES.ERROR]: sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 }),
  [FEATURES.START]: button,
  [FEATURES.STOP]: button,
  [FEATURES.SET_CURRENT]: {
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    read_only: false,
    has_feedback: true,
    keep_history: false,
  },
};

export const ROLES = Object.keys(DEFINITIONS);
export const COMMAND_ROLES = [FEATURES.START, FEATURES.STOP, FEATURES.SET_CURRENT];

export const chargerIds = (gladys, uid) => gladys.externalIds('warp', uid);

const UID = '[1-9A-HJ-NP-Za-km-z]{2,12}';

/** The uid and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) {
    return undefined;
  }
  const match = new RegExp(`:warp:(${UID}):([a-z0-9-]+)$`).exec(externalId);
  return match && ROLES.includes(match[2]) ? { uid: match[1], role: match[2] } : undefined;
}

/** The uid of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) {
    return undefined;
  }
  const match = new RegExp(`:warp:(${UID})$`).exec(externalId);
  return match ? match[1] : undefined;
}

/** The whole amperes a current command accepts: `{ low, high }` (high below low: none). */
export function currentBounds(slots, ceiling) {
  return {
    low: CURRENT.min,
    high: Math.min(ceiling, hardwareMax(slots) ?? CURRENT.max, CURRENT.max),
  };
}

/** The options of the current select: value and label only (the core's rules). */
export function currentOptions({ low, high }) {
  const options = [];
  for (let amps = low; amps <= high; amps += 1) {
    options.push({ value: String(amps), label: `${amps} A` });
  }
  return options;
}

export const deviceName = (charger) => `WARP ${charger.uid}`;

/**
 * The Gladys device of the charger. `ceiling`: the current ceiling of the
 * configuration (the select is only an offer: the command checks the bounds
 * again, on the state read just before sending).
 */
export function buildDevice(gladys, charger, { ceiling, language }) {
  const ids = chargerIds(gladys, charger.uid);
  const params = [{ name: 'uid', value: charger.uid }];
  if (charger.firmware) {
    params.push({ name: 'firmware', value: charger.firmware });
  }
  return {
    name: deviceName(charger),
    external_id: ids.device,
    model: charger.displayType ?? charger.type ?? 'WARP Charger',
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
      ...(role === FEATURES.SET_CURRENT
        ? { supported_options: currentOptions(currentBounds(charger.slots, ceiling)) }
        : {}),
    })),
    params,
  };
}

/** The connector, as the core's charging-station category reads it (undefined: unknown). */
export function connectorOf(state) {
  if (state?.iec === 4 || state?.charger === 'error' || (state?.error ?? 0) !== 0) {
    return CONNECTOR_STATUS.FAULTED;
  }
  if (state?.iec === 0) {
    return CONNECTOR_STATUS.AVAILABLE;
  }
  if (state?.iec !== undefined) {
    return CONNECTOR_STATUS.OCCUPIED;
  }
  return undefined;
}

/** The charging state (OCPP's chargingState): no vehicle or a fault, IDLE. */
export function chargingStateOf(state) {
  if (state?.charger === 'charging') {
    return CHARGING_STATE.CHARGING;
  }
  if (state?.iec === 0 || state?.iec === 4 || state?.charger === 'error') {
    return CHARGING_STATE.IDLE;
  }
  if (state?.charger === 'waiting') {
    return CHARGING_STATE.PAUSED_BY_CHARGER;
  }
  if (state?.charger === 'ready') {
    // Ready: the charger gives current, the vehicle does not take it.
    return CHARGING_STATE.PAUSED_BY_VEHICLE;
  }
  if (state?.iec === 1) {
    return CHARGING_STATE.EV_CONNECTED;
  }
  return undefined;
}

/** The text of the status feature. */
export const statusText = (state) => STATE_NAMES[state?.charger] ?? STATE_NAMES.unknown;

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * The current values of the charger's device, from one read. Offline: only
 * the status and the connector (Gladys keeps the last value of the others).
 * `index`: the energy index the guard let through (undefined: nothing).
 */
export function deviceStates(ids, charger, { online, language, ceiling, index }) {
  if (!online) {
    return [
      { role: FEATURES.STATUS, text: word(STATE_NAMES.offline, language) },
      { role: FEATURES.CONNECTOR, state: CONNECTOR_STATUS.UNAVAILABLE },
    ].map(({ role, ...value }) => ({ device_feature_external_id: ids.feature(role), ...value }));
  }
  const states = [];
  // A value outside the bounds of its feature is dropped (Gladys keeps the last one).
  const add = (role, value) => {
    const { min, max } = DEFINITIONS[role];
    if (value !== undefined && Number.isFinite(value) && value >= min && value <= max) {
      states.push({ role, state: value });
    }
  };
  const s = charger.state;
  if (s) {
    if (s.charger !== undefined) {
      states.push({ role: FEATURES.STATUS, text: word(statusText(s), language) });
    }
    add(FEATURES.CONNECTOR, connectorOf(s));
    add(FEATURES.CHARGING_STATE, chargingStateOf(s));
    if (s.iec !== undefined && s.iec !== 4) add(FEATURES.PLUGGED, s.iec === 0 ? 0 : 1);
    if (s.allowedMa !== undefined) add(FEATURES.ALLOWED_CURRENT, round(s.allowedMa / 1000, 1));
    if (s.error !== undefined) add(FEATURES.ERROR, s.error === 0 && s.iec !== 4 ? 0 : 1);
  }
  if (charger.power !== undefined) add(FEATURES.POWER, Math.round(charger.power));
  if (charger.sessionEnergy !== undefined) {
    add(FEATURES.SESSION_ENERGY, round(charger.sessionEnergy, 3));
  }
  // Never 0, never a value the guard held back.
  if (index !== undefined && index > 0) add(FEATURES.TOTAL_ENERGY, index);
  if (charger.chargeMode !== undefined) {
    states.push({
      role: FEATURES.CHARGE_MODE,
      text: word(MODE_NAMES[charger.chargeMode], language),
    });
  }
  // The select shows the current of the slot Gladys writes, when it is one of its options.
  const ma = charger.setting?.ma;
  const { low, high } = currentBounds(charger.slots, ceiling);
  if (ma !== undefined && ma % 1000 === 0 && ma / 1000 >= low && ma / 1000 <= high) {
    states.push({ role: FEATURES.SET_CURRENT, text: String(ma / 1000) });
  }
  return states.map(({ role, ...value }) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
