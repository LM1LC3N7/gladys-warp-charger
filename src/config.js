// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The user name
// and the password of the web interface are kept here in memory only: never
// logged, never written to /data, never put in a status or an error.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { CURRENT, DEFAULT_PORT, LIMITS, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  host: '',
  username: '',
  password: '',
  allow_commands: false,
  max_current: CURRENT.defaultCeiling,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Addresses that are never one charger: broadcast, multicast, "any". */
function unusableIpv4(host) {
  const [a, b, c, d] = host.split('.').map(Number);
  return (
    (a === 0 && b === 0 && c === 0 && d === 0) ||
    (a === 255 && b === 255 && c === 255 && d === 255) ||
    (a >= 224 && a <= 239)
  );
}

/**
 * The address of the charger typed by the user: an IPv4 address or a host
 * name (`warp2-AbCd.local`), with an optional port (a pasted URL is reduced
 * to its host and port).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^http:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  // Spaces and control characters (CR, LF...) are never part of an address.
  // eslint-disable-next-line no-control-regex
  if (text === '' || text.length > 260 || /[\s\u0000-\u001f\u007f]/.test(text)) {
    return undefined;
  }
  const match = text.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return unusableIpv4(host) ? undefined : { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A text typed in the form: printable ASCII without spaces at the ends, else ''. */
function ascii(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const text = value.trim();
  if (text.length < LIMITS.secretMin || text.length > LIMITS.secretMax) {
    return '';
  }
  return /^[\x20-\x7e]+$/.test(text) ? text : '';
}

const typed = (value) => typeof value === 'string' && value.trim() !== '';

/** A whole number typed in the form, bounded; the default when missing or not a number. */
function bounded(value, { min, max, fallback, round = Math.round }) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (value === null || value === undefined || String(value).trim() === '' || !Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, round(n)));
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const host = String(c.host ?? '').trim();
  // A pasted URL with `user:password@`: never parsed, never shown (it holds a password).
  const credentialsInHost = host.includes('@');
  const https = /^https:\/\//i.test(host);
  const address = credentialsInHost || https ? undefined : parseAddress(host);
  // A user name never holds a colon nor a quote (Digest joins and quotes them).
  const username = ascii(c.username);
  const user = /[:"\\]/.test(username) ? '' : username;
  const password = ascii(c.password);
  return {
    address,
    /** The text typed when it is not an address (shown in the status, cut); never with an `@`. */
    invalidHost:
      host !== '' && !address && !credentialsInHost && !https ? host.slice(0, 100) : undefined,
    /** Credentials typed in the address field: a fixed message, the text never shown. */
    credentialsInHost,
    /** An https:// address: not supported in this version (a fixed message). */
    https,
    /** Digest auth when both are given; none when both are empty. */
    auth: user && password ? { user, password } : undefined,
    /** Only one of the two given, or one refused (non-ASCII, too long, a colon or a quote). */
    badAuth:
      (typed(c.username) || typed(c.password)) && !(user && password)
        ? typed(c.username) && typed(c.password)
          ? 'invalid'
          : 'incomplete'
        : undefined,
    allowCommands: strictTrue(c.allow_commands),
    maxCurrent: bounded(c.max_current, {
      min: CURRENT.min,
      max: CURRENT.max,
      fallback: CURRENT.defaultCeiling,
      round: Math.floor,
    }),
    pollInterval: bounded(c.poll_interval, {
      min: POLL_INTERVAL.min,
      max: POLL_INTERVAL.max,
      fallback: POLL_INTERVAL.default,
    }),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** What identifies the credentials, to tell a change (never stored, never logged). */
export const credentialsKey = (config) =>
  config.auth ? JSON.stringify([config.auth.user, config.auth.password]) : '';
