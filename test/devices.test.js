// -----------------------------------------------------------------------------
// The Gladys device (pure): ids, categories and units of the core, options
// the core accepts (its own normalizeSupportedOptions when the clone is
// there, else the same rules), no switch, the states of one read.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { FEATURES } from '../src/constants.js';
import {
  COMMAND_ROLES,
  ROLES,
  buildDevice,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
} from '../src/devices.js';

const CORE = '/home/claude/code/Gladys/server/utils';
const require = createRequire(import.meta.url);
const core = existsSync(`${CORE}/constants.js`) ? require(`${CORE}/constants.js`) : undefined;
let normalizeSupportedOptions;
try {
  normalizeSupportedOptions = require(
    `${CORE}/normalizeSupportedOptions.js`,
  ).normalizeSupportedOptions;
} catch {
  normalizeSupportedOptions = undefined;
}

const gladys = {
  externalIds: (type, id) => ({
    device: `ext:test:${type}:${id}`,
    feature: (key) => `ext:test:${type}:${id}:${key}`,
  }),
};
const ids = gladys.externalIds('warp', 'Xy7Kq');
const slots = [
  { maxMa: 32000, active: true },
  { maxMa: 20000, active: true },
  undefined,
  undefined,
  { maxMa: 32000, active: true },
];
const devices = [6, 16, 32].map((ceiling) =>
  buildDevice(gladys, { uid: 'Xy7Kq', displayType: 'WARP3', slots }, { ceiling, language: 'en' }),
);
const device = devices[1];

test('ids: the uid (case kept), the role; parsed back strictly', () => {
  assert.equal(device.external_id, 'ext:test:warp:Xy7Kq');
  assert.deepEqual(parseFeatureId('ext:test:warp:Xy7Kq:stop-charge'), {
    uid: 'Xy7Kq',
    role: FEATURES.STOP,
  });
  assert.equal(parseFeatureId('ext:test:warp:Xy7Kq:nope'), undefined);
  assert.equal(parseFeatureId('ext:test:warp:Xy0Kq:stop-charge'), undefined);
  assert.equal(parseFeatureId(42), undefined);
  assert.equal(parseDeviceId('ext:test:warp:Xy7Kq'), 'Xy7Kq');
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').at(-1)),
    ROLES,
  );
});

test('no switch, no writable binary; the writable features are the commands', () => {
  for (const f of device.features) {
    if (f.type === 'binary') assert.equal(f.read_only, true, f.name);
    assert.notEqual(f.category, 'switch', f.name);
    const role = parseFeatureId(f.external_id).role;
    assert.equal(f.read_only, !COMMAND_ROLES.includes(role), role);
  }
});

test('units: only those the core lists for the category', { skip: !core }, () => {
  const byCategory = core.DEVICE_FEATURE_UNITS_BY_CATEGORY;
  for (const f of device.features) {
    if (f.unit === undefined) continue;
    assert.ok(byCategory[f.category]?.includes(f.unit), `${f.name}: ${f.category} ${f.unit}`);
  }
  for (const f of device.features) {
    assert.ok(Object.values(core.DEVICE_FEATURE_CATEGORIES).includes(f.category), f.category);
  }
});

test('supported options: the rules of the core (label, value, unique, no other key)', () => {
  for (const d of devices) {
    for (const f of d.features.filter((x) => x.supported_options)) {
      const values = new Set();
      for (const o of f.supported_options) {
        assert.deepEqual(Object.keys(o).sort(), ['label', 'value']);
        assert.equal(typeof o.label, 'string');
        assert.ok(o.label.length > 0 && o.label === o.label.trim(), o.label);
        assert.ok(
          Number.isInteger(o.value) || (typeof o.value === 'string' && o.value.trim() !== ''),
        );
        assert.ok(!values.has(String(o.value)), 'unique');
        values.add(String(o.value));
      }
      if (normalizeSupportedOptions) {
        const allowStringValues = f.category === 'text' && f.type === 'select';
        assert.doesNotThrow(() =>
          normalizeSupportedOptions(f.supported_options, { allowStringValues }),
        );
      }
    }
  }
  const select = (d) => d.features.find((f) => f.external_id.endsWith(':set-current'));
  assert.deepEqual(
    select(devices[0]).supported_options.map((o) => o.value),
    ['6'],
  );
  assert.equal(select(devices[2]).supported_options.at(-1).value, '20', 'the cable limit');
});

test('states: a fault is a fault, an unknown value is not published, never a text as 0', () => {
  const states = deviceStates(
    ids,
    {
      state: { iec: 4, charger: 'error', allowedMa: 0, error: 3 },
      power: undefined,
      chargeMode: undefined,
      setting: { source: 'global', ma: 16_500 },
      slots,
    },
    { online: true, language: 'en', ceiling: 16, index: 0 },
  );
  const byRole = Object.fromEntries(
    states.map((s) => [s.device_feature_external_id.split(':').at(-1), s]),
  );
  assert.equal(byRole.error.state, 1);
  assert.equal(byRole['connector-status'].state, 4);
  assert.equal(byRole['charging-state'].state, 4);
  assert.equal(byRole.plugged, undefined, 'unknown on a fault');
  assert.equal(byRole['total-energy'], undefined, 'never 0');
  assert.equal(byRole.power, undefined);
  assert.equal(byRole['set-current'], undefined, 'not one of the options');
  assert.equal(byRole['charge-mode'], undefined);
  const offline = deviceStates(ids, {}, { online: false, language: 'fr', ceiling: 16 });
  assert.deepEqual(
    offline.map((s) => s.device_feature_external_id.split(':').at(-1)),
    ['status', 'connector-status'],
  );
});
