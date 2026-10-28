// -----------------------------------------------------------------------------
// The answers of the WARP topics read, as the API reference documents them
// (docs.warp-charger.com, firmware 2.x, WARP1 to WARP4). Pure.
//
// The answers come from the network: only own fields of a plain object are
// read, each with its exact type and range (a missing or mistyped value is
// undefined, never a default, so that a command is refused rather than
// decided on a guess, and nothing is published as a measure). JSON.parse
// keeps `__proto__` as a plain own key: it never reaches a prototype, and it
// is never read. `charge_tracker/current_charge` also names the user and the
// NFC tag of the session: only `user_id` and `meter_start` are read from it.
// -----------------------------------------------------------------------------

import { CHARGER_TYPES, CHARGER_STATES, CHARGE_MODES, LIMITS, SLOT } from '../constants.js';
import { ChargerError, ERROR_KINDS } from './http.js';

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const plain = (data) => data !== null && typeof data === 'object' && !Array.isArray(data);
const intIn = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;
const shape = (message) => new ChargerError(ERROR_KINDS.PROTOCOL, message, { sent: true });

/** A short text from the charger, without control characters. */
export function text(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean === '' ? undefined : clean.slice(0, LIMITS.textLength);
}

/** Tinkerforge UIDs are base58 (no 0, O, I, l): the id of the charger, case kept. */
const UID = /^[1-9A-HJ-NP-Za-km-z]{2,12}$/;
export const uidOf = (value) => (typeof value === 'string' && UID.test(value) ? value : undefined);

/** `info/name` -> the identity: uid, type (warp..warp4, wem), display type. */
export function parseName(data) {
  if (!plain(data)) {
    throw shape('info/name: not an object');
  }
  const type = typeof own(data, 'type') === 'string' ? own(data, 'type') : undefined;
  return {
    uid: uidOf(own(data, 'uid')),
    type: type && /^[a-z0-9]{1,12}$/.test(type) ? type : undefined,
    charger: type !== undefined && CHARGER_TYPES.has(type),
    displayType: text(own(data, 'display_type')),
  };
}

/** `info/version` -> the firmware version text ("2.6.4+675aeb6a"). */
export function parseVersion(data) {
  if (!plain(data)) {
    throw shape('info/version: not an object');
  }
  return text(own(data, 'firmware'));
}

/** `evse/state`: IEC 61851 state, charger state, allowed current (mA), error state. */
export function parseState(data) {
  if (!plain(data)) {
    throw shape('evse/state: not an object');
  }
  const chargerCode = intIn(own(data, 'charger_state'), 0, 4);
  return {
    /** 0 A (no vehicle), 1 B (connected), 2 C (charging), 3 D, 4 E/F (error). */
    iec: intIn(own(data, 'iec61851_state'), 0, 4),
    charger: chargerCode === undefined ? undefined : CHARGER_STATES[chargerCode],
    allowedMa: intIn(own(data, 'allowed_charging_current'), 0, 32_000),
    /** 0 OK, 2 switch, 3 DC fault, 4 contactor, 5 communication. */
    error: intIn(own(data, 'error_state'), 0, 5),
    /** WARP2 and later only (undefined on WARP1). */
    dcFault: intIn(own(data, 'dc_fault_current_state'), 0, 6),
  };
}

/** A current in mA as a slot holds it: 0 (blocks) or 6000 to 32000. */
const slotMa = (value) => {
  const ma = intIn(value, 0, 32_000);
  return ma === 0 || (ma !== undefined && ma >= 6_000) ? ma : undefined;
};

/** `evse/slots` -> [{ maxMa, active }] (an entry that cannot be read: undefined). */
export function parseSlots(data) {
  if (!Array.isArray(data) || data.length <= SLOT.BUTTON || data.length > 32) {
    throw shape('evse/slots: not the list of slots');
  }
  return data.map((slot) => {
    if (!plain(slot)) return undefined;
    const maxMa = slotMa(own(slot, 'max_current'));
    const active = own(slot, 'active');
    return maxMa === undefined || typeof active !== 'boolean' ? undefined : { maxMa, active };
  });
}

/** `evse/global_current` and `evse/external_current` -> mA (0 or 6000 to 32000). */
export function parseCurrent(data) {
  if (!plain(data)) {
    throw shape('current: not an object');
  }
  return slotMa(own(data, 'current'));
}

/** `evse/external_enabled` -> boolean. */
export function parseEnabled(data) {
  if (!plain(data) || typeof own(data, 'enabled') !== 'boolean') {
    throw shape('enabled: not an object');
  }
  return own(data, 'enabled');
}

/** `meters/0/value_ids` -> the MeterValueIDs, in the order of the values. */
export function parseMeterIds(data) {
  if (!Array.isArray(data) || data.length > LIMITS.meterValues) {
    throw shape('meters/0/value_ids: not a list');
  }
  return data.map((id) => intIn(id, 0, 65_535));
}

/** `meters/0/values` -> numbers (null, a value not available yet: undefined). */
export function parseMeterValues(data) {
  if (!Array.isArray(data) || data.length > LIMITS.meterValues) {
    throw shape('meters/0/values: not a list');
  }
  return data.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined));
}

/** The value of a MeterValueID, when the ids and the values match. */
export function meterValue(ids, values, id) {
  if (!ids || !values || ids.length !== values.length) {
    return undefined;
  }
  const index = ids.indexOf(id);
  return index < 0 ? undefined : values[index];
}

/** `charge_tracker/current_charge` -> { active, meterStart } (no user, no tag read). */
export function parseCurrentCharge(data) {
  if (!plain(data)) {
    throw shape('charge_tracker/current_charge: not an object');
  }
  const user = intIn(own(data, 'user_id'), -1, 255);
  const start = own(data, 'meter_start');
  return {
    active: user === undefined ? undefined : user >= 0,
    meterStart:
      typeof start === 'number' && Number.isFinite(start) && start >= 0 ? start : undefined,
  };
}

/** `power_manager/charge_mode` -> the mode name, else undefined. */
export function parseChargeMode(data) {
  if (!plain(data)) {
    throw shape('power_manager/charge_mode: not an object');
  }
  const mode = own(data, 'mode');
  return Number.isInteger(mode) && Object.hasOwn(CHARGE_MODES, mode)
    ? CHARGE_MODES[mode]
    : undefined;
}

/**
 * The current the charger may give once started (mA): the lowest of the
 * slots that hold a setting (the cables 0 and 1, the global current 5, the
 * external control 8 when active). The dynamic slots (charge manager,
 * Modbus, OCPP, automation...) may rise by themselves: never counted on.
 * Undefined when one of them cannot be read.
 */
export function capFixed(slots) {
  let cap;
  for (const index of [SLOT.INCOMING_CABLE, SLOT.OUTGOING_CABLE, SLOT.GLOBAL, SLOT.EXTERNAL]) {
    const slot = slots[index];
    if (slot === undefined) {
      if (index === SLOT.EXTERNAL && slots.length <= SLOT.EXTERNAL) continue;
      return undefined;
    }
    if (slot.active && slot.maxMa > 0) {
      cap = cap === undefined ? slot.maxMa : Math.min(cap, slot.maxMa);
    }
  }
  return cap;
}

/** Whether the cable slots (0 and 1) were readable (their limit bounds the current). */
export const cablesKnown = (slots) =>
  slots?.[SLOT.INCOMING_CABLE] !== undefined && slots?.[SLOT.OUTGOING_CABLE] !== undefined;

/** The hardware limit (whole A): the cable slots (0 incoming, 1 outgoing) when active. */
export function hardwareMax(slots) {
  let max;
  for (const index of [SLOT.INCOMING_CABLE, SLOT.OUTGOING_CABLE]) {
    const slot = slots?.[index];
    if (slot?.active && slot.maxMa >= 6_000) {
      const amps = Math.floor(slot.maxMa / 1000);
      max = max === undefined ? amps : Math.min(max, amps);
    }
  }
  return max;
}
