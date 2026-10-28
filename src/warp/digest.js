// -----------------------------------------------------------------------------
// HTTP Digest access authentication (RFC 2617, MD5, qop "auth"), as the WARP
// firmware asks when users are configured (realm `esp32-lib`). Pure.
//
// The challenge comes from the network: every field is bounded and checked
// (no quote, backslash nor control character), an algorithm other than MD5
// or a qop without "auth" is refused (never a weaker answer). The password
// only enters the hash HA1, computed in memory for each answer: never kept,
// never logged, never written to /data.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';

const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');
const FIELD = /^[\x20-\x21\x23-\x5b\x5d-\x7e]{1,200}$/;

/**
 * The Digest challenge of a `WWW-Authenticate` header, or undefined when
 * there is none usable: `{ realm, nonce, opaque, qop, stale }`.
 */
export function parseChallenge(header) {
  const text = Array.isArray(header) ? header.find((h) => /^\s*digest\s/i.test(h)) : header;
  if (typeof text !== 'string' || text.length > 1024 || !/^\s*digest\s/i.test(text)) {
    return undefined;
  }
  const fields = {};
  const pattern = /([a-z]+)=(?:"([^"]*)"|([^\s,"]+))/gi;
  for (const match of text.replace(/^\s*digest\s+/i, '').matchAll(pattern)) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3];
    if (!FIELD.test(value) || Object.hasOwn(fields, key)) {
      return undefined;
    }
    fields[key] = value;
  }
  if (!fields.realm || !fields.nonce) {
    return undefined;
  }
  if (fields.algorithm !== undefined && fields.algorithm.toUpperCase() !== 'MD5') {
    return undefined;
  }
  let qop;
  if (fields.qop !== undefined) {
    if (!fields.qop.split(',').some((q) => q.trim() === 'auth')) {
      return undefined;
    }
    qop = 'auth';
  }
  return {
    realm: fields.realm,
    nonce: fields.nonce,
    opaque: fields.opaque,
    qop,
    algorithm: fields.algorithm === undefined ? undefined : 'MD5',
    stale: String(fields.stale ?? '').toLowerCase() === 'true',
  };
}

/**
 * The `Authorization` header answering `challenge` for one request. `nc`:
 * the count of answers to this nonce (1 for the first).
 */
export function authorization({ challenge, user, password, method, uri, nc, cnonce }) {
  const ha1 = md5(`${user}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const count = nc.toString(16).padStart(8, '0');
  const client = cnonce ?? randomBytes(8).toString('hex');
  const response = challenge.qop
    ? md5(`${ha1}:${challenge.nonce}:${count}:${client}:${challenge.qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);
  const parts = [
    `username="${user}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    ...(challenge.algorithm ? [`algorithm=${challenge.algorithm}`] : []),
    ...(challenge.qop ? [`qop=${challenge.qop}`, `nc=${count}`, `cnonce="${client}"`] : []),
    `response="${response}"`,
    ...(challenge.opaque !== undefined ? [`opaque="${challenge.opaque}"`] : []),
  ];
  return `Digest ${parts.join(', ')}`;
}
