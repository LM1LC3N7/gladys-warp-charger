// -----------------------------------------------------------------------------
// One plain HTTP/1.1 exchange with the charger (node:http, a new connection
// each time, `Connection: close`, no redirect followed, bounded time and
// size). Every failure becomes a ChargerError whose `sent` says whether the
// request may have reached the charger:
//   - nothing is written before the connection is up: `beforeSend()` runs
//     then, right before the first byte, and may still refuse (nothing sent);
//   - an abort (`signal`) destroys the connection, and the promise settles
//     only once the socket is closed: a new connection never opens while the
//     old one is still there.
// The headers given (Authorization) are never logged. No User-Agent is set:
// node:http sends none.
// -----------------------------------------------------------------------------

import { request as httpRequest } from 'node:http';
import { LIMITS } from '../constants.js';

/** The kinds of failure the rest of the code tells apart. */
export const ERROR_KINDS = Object.freeze({
  /** Nothing accepted the connection. Nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Connected, then silent or cut: the request may have been received. */
  TIMEOUT: 'timeout',
  /** An HTTP status other than 2xx (`status` holds it). */
  HTTP: 'http',
  /** 401: the user name and password refused, or asked for. */
  AUTH: 'auth',
  /** 429 (`retryAfter` in ms when the charger gave one). */
  RATE_LIMITED: 'rate_limited',
  /** Too large, not JSON, not the expected shape. */
  PROTOCOL: 'protocol',
  /** The time a command was given ran out before its request: nothing was sent. */
  LATE: 'late',
  /** Ended by the app (a stop takes the line). */
  ABORTED: 'aborted',
  /** `beforeSend` refused right before the first byte: nothing was sent. */
  YIELDED: 'yielded',
});

export class ChargerError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'ChargerError';
    this.kind = kind;
    this.sent = false;
    for (const [key, value] of Object.entries(details)) {
      this[key] = value;
    }
  }
}

const SAFE_HEADER = /^[\x20-\x7e]*$/;

/**
 * @param {{ host: string, port: number, method?: string, path: string,
 *   headers?: object, body?: string, timeoutMs?: number, signal?: AbortSignal,
 *   beforeSend?: () => void }} options
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
export function request({
  host,
  port,
  method = 'GET',
  path,
  headers = {},
  body,
  timeoutMs = 5000,
  signal,
  beforeSend,
}) {
  return new Promise((resolve, reject) => {
    for (const value of [path, ...Object.values(headers)]) {
      if (typeof value !== 'string' || !SAFE_HEADER.test(value)) {
        reject(new ChargerError(ERROR_KINDS.PROTOCOL, 'Invalid request'));
        return;
      }
    }
    if (signal?.aborted) {
      reject(new ChargerError(ERROR_KINDS.ABORTED, 'Aborted'));
      return;
    }
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
    let settled = false;
    let connected = false;
    let sent = false;
    let socket;
    let outcome;
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const [fn, value] = outcome;
      if (value instanceof ChargerError) {
        value.sent = sent;
      }
      fn(value);
    };
    // Settles once the socket is closed, whatever the outcome (the connection
    // is destroyed if still open): never two connections to the charger.
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      outcome = [fn, value];
      req.destroy();
      if (socket && !socket.closed) {
        socket.once('close', done);
      } else {
        done();
      }
    };
    const failure = (err) =>
      connected
        ? new ChargerError(ERROR_KINDS.TIMEOUT, `Connection lost: ${err.code ?? 'error'}`)
        : new ChargerError(ERROR_KINDS.UNREACHABLE, `Unreachable: ${err.code ?? 'error'}`);
    const req = httpRequest(
      {
        host,
        port,
        method,
        path,
        agent: false,
        headers: {
          Connection: 'close',
          Accept: 'application/json',
          ...headers,
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }
            : {}),
        },
      },
      (res) => {
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > LIMITS.responseBytes) {
          finish(reject, new ChargerError(ERROR_KINDS.PROTOCOL, 'Answer too large'));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > LIMITS.responseBytes) {
            finish(reject, new ChargerError(ERROR_KINDS.PROTOCOL, 'Answer too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(resolve, {
            status: res.statusCode ?? 0,
            headers: res.headers ?? {},
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', (err) => finish(reject, failure(err)));
      },
    );
    const send = () => {
      connected = true;
      if (settled) return;
      try {
        beforeSend?.();
      } catch (err) {
        finish(
          reject,
          new ChargerError(ERROR_KINDS.YIELDED, err?.message ?? 'Not sent', { cause: err }),
        );
        return;
      }
      sent = true;
      req.end(payload);
    };
    req.on('socket', (s) => {
      socket = s;
      if (s.connecting) {
        s.once('connect', send);
      } else {
        send();
      }
    });
    // A plain (ref'd) timer: the exchange keeps the process alive until it ends.
    const timer = setTimeout(() => {
      finish(
        reject,
        connected
          ? new ChargerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout')
          : new ChargerError(ERROR_KINDS.UNREACHABLE, 'Unreachable: timeout'),
      );
    }, timeoutMs);
    const onAbort = () => finish(reject, new ChargerError(ERROR_KINDS.ABORTED, 'Aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => finish(reject, failure(err)));
  });
}
