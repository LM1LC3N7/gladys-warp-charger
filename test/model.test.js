// -----------------------------------------------------------------------------
// The answers of the topics (pure): documented shapes read, everything else
// unknown (never a default, never a 0 that is not one); Digest; the config.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { authorization, parseChallenge } from '../src/warp/digest.js';
import {
  capWithoutButton,
  hardwareMax,
  meterValue,
  parseChargeMode,
  parseCurrent,
  parseCurrentCharge,
  parseMeterValues,
  parseName,
  parseSlots,
  parseState,
} from '../src/warp/model.js';

test('info/name: the uid (base58, case kept), a charger type; the WEM is not one', () => {
  assert.deepEqual(
    parseName({
      name: 'warp2-AbCd',
      type: 'warp2',
      display_type: 'WARP2 Charger Pro',
      uid: 'AbCd',
    }),
    { uid: 'AbCd', type: 'warp2', charger: true, displayType: 'WARP2 Charger Pro' },
  );
  assert.equal(parseName({ type: 'wem', uid: 'AbCd' }).charger, false);
  assert.equal(parseName({ type: 'warp4', uid: 'Ab0d' }).uid, undefined, 'no 0 in base58');
  assert.equal(parseName({ type: 'warp4', uid: 'a:b' }).uid, undefined);
  assert.equal(parseName({ type: 'warp4', uid: 'x' }).uid, undefined);
  assert.throws(() => parseName([]));
  assert.throws(() => parseName(null));
  // A __proto__ key stays a plain key, never read.
  const evil = JSON.parse('{"__proto__": {"uid": "Evil"}, "type": "warp3"}');
  assert.equal(parseName(evil).uid, undefined);
  assert.equal({}.uid, undefined);
});

test('evse/state: documented ranges only', () => {
  assert.deepEqual(
    parseState({
      iec61851_state: 2,
      charger_state: 3,
      allowed_charging_current: 16000,
      error_state: 0,
      dc_fault_current_state: 0,
    }),
    { iec: 2, charger: 'charging', allowedMa: 16000, error: 0, dcFault: 0 },
  );
  const odd = parseState({ iec61851_state: 9, charger_state: '3', allowed_charging_current: 1.5 });
  assert.deepEqual(odd, {
    iec: undefined,
    charger: undefined,
    allowedMa: undefined,
    error: undefined,
    dcFault: undefined,
  });
});

test('evse/slots: 0 or 6 to 32 A and a boolean, else unknown; too short refused', () => {
  const slots = parseSlots([
    { max_current: 32000, active: true },
    { max_current: 16000, active: true },
    { max_current: 3000, active: true },
    { max_current: 0, active: false },
    { max_current: 0, active: true },
    { max_current: 10000, active: true },
  ]);
  assert.deepEqual(slots[2], undefined);
  assert.deepEqual(slots[4], { maxMa: 0, active: true });
  assert.throws(() => parseSlots([{ max_current: 0, active: true }]));
  assert.equal(capWithoutButton(slots), undefined, 'a slot unknown: the cap unknown');
  slots[2] = { maxMa: 32000, active: false };
  assert.equal(capWithoutButton(slots), 10000);
  assert.equal(hardwareMax(slots), 16);
});

test('currents, meter values, session, charge mode', () => {
  assert.equal(parseCurrent({ current: 16000 }), 16000);
  assert.equal(parseCurrent({ current: 5000 }), undefined);
  assert.equal(parseCurrent({ current: '16000' }), undefined);
  const values = parseMeterValues([230.1, null, 1234.5]);
  assert.deepEqual(values, [230.1, undefined, 1234.5]);
  assert.equal(meterValue([1, 74, 209], values, 209), 1234.5);
  assert.equal(meterValue([1, 74, 209], values, 74), undefined, 'null is unknown, never 0');
  assert.equal(meterValue([1, 74], values, 74), undefined, 'ids and values must match');
  assert.equal(meterValue([209], [7200, 1234.5], 209), undefined, 'never a value of another id');
  assert.deepEqual(parseCurrentCharge({ user_id: -1, meter_start: 12 }), {
    active: false,
    meterStart: 12,
  });
  assert.deepEqual(parseCurrentCharge({ user_id: 3, meter_start: null }), {
    active: true,
    meterStart: undefined,
  });
  assert.equal(parseChargeMode({ mode: 4 }), undefined, 'the resolver "default" is not a mode');
  assert.equal(parseChargeMode({ mode: 2 }), 'pv');
});

test('Digest: the RFC 2617 example, MD5 only, hostile challenges refused', () => {
  // RFC 2617 section 3.5.
  const challenge = parseChallenge(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
  );
  const header = authorization({
    challenge,
    user: 'Mufasa',
    password: 'Circle Of Life',
    method: 'GET',
    uri: '/dir/index.html',
    nc: 1,
    cnonce: '0a4f113b',
  });
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /nc=00000001/);
  assert.equal(parseChallenge('Basic realm="x"'), undefined);
  assert.equal(parseChallenge('Digest realm="x", nonce="n", algorithm=SHA-256'), undefined);
  assert.equal(parseChallenge('Digest realm="x", nonce="n", qop="auth-int"'), undefined);
  assert.equal(parseChallenge('Digest realm="x\r\nX: y", nonce="n"'), undefined);
  assert.equal(parseChallenge('Digest nonce="n"'), undefined);
  assert.equal(parseChallenge(`Digest realm="${'x'.repeat(2000)}", nonce="n"`), undefined);
  assert.equal(parseChallenge('Digest realm="r", nonce="n", stale=TRUE').stale, true);
  const md5 = (t) => createHash('md5').update(t).digest('hex');
  assert.equal(md5('a').length, 32);
});

test('the address: IPv4 or host name, optional port; never broadcast, multicast, 0.0.0.0, https', () => {
  assert.deepEqual(parseAddress('192.168.1.70'), { host: '192.168.1.70', port: 80 });
  assert.deepEqual(parseAddress('http://WARP3-AbCd.local:8080/'), {
    host: 'warp3-abcd.local',
    port: 8080,
  });
  for (const bad of [
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '1.2.3',
    'a b',
    'x:0',
    'x:70000',
    'a\nb',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  assert.equal(normalizeConfig({ host: 'https://192.168.1.70' }).https, true);
  assert.equal(normalizeConfig({ host: 'https://192.168.1.70' }).address, undefined);
  const withCreds = normalizeConfig({ host: 'http://u:secret@192.168.1.70' });
  assert.equal(withCreds.credentialsInHost, true);
  assert.equal(withCreds.invalidHost, undefined, 'never shown');
});

test('the configuration: strict option, bounded numbers, credentials both or none', () => {
  const c = normalizeConfig({});
  assert.equal(c.allowCommands, false);
  assert.equal(c.maxCurrent, 16);
  assert.equal(c.pollInterval, 30);
  assert.equal(normalizeConfig({ allow_commands: 'yes' }).allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: true }).allowCommands, true);
  assert.equal(normalizeConfig({ max_current: 99 }).maxCurrent, 32);
  assert.equal(normalizeConfig({ max_current: 2 }).maxCurrent, 6);
  assert.equal(normalizeConfig({ max_current: '' }).maxCurrent, 16);
  assert.equal(normalizeConfig({ max_current: 16.9 }).maxCurrent, 16, 'rounded down');
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 10);
  assert.equal(normalizeConfig({ username: 'u' }).badAuth, 'incomplete');
  assert.equal(normalizeConfig({ username: 'a:b', password: 'p' }).badAuth, 'invalid');
  assert.equal(normalizeConfig({ username: 'a"b', password: 'p' }).badAuth, 'invalid');
  assert.equal(normalizeConfig({ username: 'u', password: 'pé' }).badAuth, 'invalid');
  assert.deepEqual(normalizeConfig({ username: 'u', password: 'p' }).auth, {
    user: 'u',
    password: 'p',
  });
});
