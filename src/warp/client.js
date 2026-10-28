// -----------------------------------------------------------------------------
// The WARP HTTP API (docs.warp-charger.com, MQTT/HTTP API reference): one
// topic per request, `GET` to read a state, `PUT` with a JSON body to write
// one (the documentation's `curl -d`; PUT and POST are both accepted). With
// credentials, HTTP Digest (src/warp/digest.js): the challenge of the last
// 401 is kept (never the password nor a hash of it) and answered with a
// growing count; a 401 to a kept challenge is answered once more with the
// new one (a nonce renewed is not a refusal), a 401 to a fresh one is a
// refusal.
//
// Reads are never retried here (the app spaces its new tries); a write is
// never retried at all (it may have reached the charger). A redirection is
// never followed (an HTTPS-only charger answers one: said in the status).
// -----------------------------------------------------------------------------

import { TIMINGS } from '../constants.js';
import { authorization, parseChallenge } from './digest.js';
import { ChargerError, ERROR_KINDS, request as httpRequest } from './http.js';

/** Retry-After in ms: seconds, or an HTTP date against the charger's own `Date`. */
function retryAfterOf(headers) {
  const raw = headers?.['retry-after'];
  if (typeof raw !== 'string') return undefined;
  if (/^\s*\d{1,6}\s*$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  const now = Date.parse(headers?.date ?? '');
  // Without a readable `Date` of the charger, a date is not compared with our clock.
  return Number.isFinite(at) && Number.isFinite(now) && at > now ? at - now : undefined;
}

function statusError(res) {
  const { status } = res;
  if (status === 401) {
    return new ChargerError(ERROR_KINDS.AUTH, 'HTTP 401', { status });
  }
  if (status === 429) {
    return new ChargerError(ERROR_KINDS.RATE_LIMITED, 'HTTP 429', {
      status,
      retryAfter: retryAfterOf(res.headers),
    });
  }
  return new ChargerError(ERROR_KINDS.HTTP, `HTTP ${status}`, {
    status,
    redirect: status >= 300 && status < 400,
  });
}

export class WarpClient {
  constructor({ transport = httpRequest, now = () => performance.now() } = {}) {
    this.transport = transport;
    this.now = now;
    /** `${address}\n${user}` -> { challenge, nc }: the last Digest challenge (no secret). */
    this.challenges = new Map();
  }

  /** Forgets the Digest challenges (new credentials). */
  reset() {
    this.challenges.clear();
  }

  /**
   * One request (two with a Digest challenge to answer). `beforeSend` runs
   * right before each attempt leaves; `signal` aborts it. Resolves the
   * answer of a 2xx, throws a ChargerError otherwise (its `sent` says
   * whether a request may have reached the charger).
   */
  async exchange(address, auth, { method = 'GET', path, body, timeoutMs, signal, beforeSend }) {
    const until = this.now() + timeoutMs;
    const left = () => Math.max(1, Math.round(until - this.now()));
    const key = `${address.host}:${address.port}\n${auth?.user ?? ''}`;
    let sent = false;
    const attempt = async (entry) => {
      const headers = {};
      if (auth && entry) {
        entry.nc += 1;
        headers.Authorization = authorization({
          challenge: entry.challenge,
          user: auth.user,
          password: auth.password,
          method,
          uri: path,
          nc: entry.nc,
        });
      }
      try {
        return await this.transport({
          host: address.host,
          port: address.port,
          method,
          path,
          headers,
          body,
          timeoutMs: left(),
          signal,
          beforeSend: () => {
            beforeSend?.();
            sent = true;
          },
        });
      } catch (err) {
        if (err instanceof ChargerError) err.sent = err.sent || sent;
        throw err;
      }
    };
    const kept = auth ? this.challenges.get(key) : undefined;
    let res = await attempt(kept);
    if (res.status === 401 && auth) {
      const challenge = parseChallenge(res.headers?.['www-authenticate']);
      const renewed =
        challenge && (!kept || challenge.stale || challenge.nonce !== kept.challenge.nonce);
      if (!renewed) {
        this.challenges.delete(key);
        throw Object.assign(statusError(res), { sent, refused: true });
      }
      if (left() < TIMINGS.commandMinRequest / 2) {
        throw Object.assign(
          new ChargerError(ERROR_KINDS.TIMEOUT, 'No time left to answer the challenge'),
          { sent },
        );
      }
      const entry = { challenge, nc: 0 };
      this.challenges.set(key, entry);
      res = await attempt(entry);
      if (res.status === 401) {
        this.challenges.delete(key);
        throw Object.assign(statusError(res), { sent, refused: true });
      }
    }
    if (res.status < 200 || res.status >= 300) {
      throw Object.assign(statusError(res), { sent, refused: res.status === 401 && !auth });
    }
    return res;
  }

  /** GET a topic: its JSON (null included). */
  async get(address, auth, path, options) {
    const res = await this.exchange(address, auth, { ...options, method: 'GET', path });
    try {
      return JSON.parse(res.body);
    } catch {
      throw new ChargerError(ERROR_KINDS.PROTOCOL, 'Not JSON', { sent: true });
    }
  }

  /** PUT a JSON value to a topic (a command: `null`). The answer is not read. */
  async put(address, auth, path, value, options) {
    await this.exchange(address, auth, {
      ...options,
      method: 'PUT',
      path,
      body: JSON.stringify(value),
    });
  }
}

/** A short reason for the status and the logs (never a body, never a header). */
export function errorReason(err) {
  if (err?.kind === ERROR_KINDS.HTTP) {
    return err.redirect ? `HTTP ${err.status} (redirect)` : `HTTP ${err.status}`;
  }
  return err?.kind ?? 'error';
}
