// -----------------------------------------------------------------------------
// The HTTP layer against real local servers of the kit (127.0.0.1): answers
// read, oversized ones cut, redirects never followed, a silent charger, an
// abort that settles once the socket is closed, nothing written when
// `beforeSend` refuses, Digest answered and a refusal told apart.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WarpClient } from '../src/warp/client.js';
import { ERROR_KINDS, request } from '../src/warp/http.js';
import { httpServer, reply } from './kit/http.mjs';
import { blackhole, refusePort } from './kit/net.mjs';

const md5 = (t) => createHash('md5').update(t).digest('hex');

test('a JSON answer; an oversized one is cut; a redirect is not followed', async (t) => {
  const srv = await httpServer({
    routes: {
      'GET /evse/state': { iec61851_state: 1 },
      'GET /big': () => reply(200, 'x'.repeat(40_000)),
      'GET /moved': () => reply(301, '', { location: 'https://127.0.0.1/' }),
    },
  });
  t.after(() => srv.close());
  const client = new WarpClient();
  const address = { host: srv.host, port: srv.port };
  assert.deepEqual(await client.get(address, undefined, '/evse/state', { timeoutMs: 2000 }), {
    iec61851_state: 1,
  });
  await assert.rejects(client.get(address, undefined, '/big', { timeoutMs: 2000 }), {
    kind: ERROR_KINDS.PROTOCOL,
  });
  // Without a declared length (chunked): cut while it streams.
  srv.bigBody = 40_000;
  await assert.rejects(client.get(address, undefined, '/evse/state', { timeoutMs: 2000 }), {
    kind: ERROR_KINDS.PROTOCOL,
  });
  srv.bigBody = 0;
  await assert.rejects(client.get(address, undefined, '/moved', { timeoutMs: 2000 }), {
    kind: ERROR_KINDS.HTTP,
    status: 301,
    redirect: true,
  });
  assert.equal(srv.count('GET /moved'), 1);
});

test('unreachable: nothing sent; silent: a timeout that may have been received', async (t) => {
  const port = await refusePort();
  await assert.rejects(
    request({ host: '127.0.0.1', port, path: '/info/name', timeoutMs: 1000 }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE && err.sent === false,
  );
  const hole = await blackhole();
  t.after(() => hole.close());
  await assert.rejects(
    request({ host: hole.host, port: hole.port, path: '/info/name', timeoutMs: 200 }),
    (err) => err.kind === ERROR_KINDS.TIMEOUT && err.sent === true,
  );
});

test('an abort settles once the socket is closed; beforeSend refusing sends nothing', async (t) => {
  const hole = await blackhole();
  t.after(() => hole.close());
  const controller = new AbortController();
  const pending = request({
    host: hole.host,
    port: hole.port,
    path: '/evse/slots',
    timeoutMs: 5000,
    signal: controller.signal,
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(hole.connections, 1);
  controller.abort();
  await assert.rejects(pending, (err) => err.kind === ERROR_KINDS.ABORTED && err.sent === true);
  const received = hole.received;
  await assert.rejects(
    request({
      host: hole.host,
      port: hole.port,
      method: 'PUT',
      path: '/evse/start_charging',
      body: 'null',
      timeoutMs: 1000,
      beforeSend: () => {
        throw new Error('the option is off');
      },
    }),
    (err) => err.kind === ERROR_KINDS.YIELDED && err.sent === false,
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(hole.received, received, 'not a byte of the refused request');
});

test('header injection refused before any connection', async () => {
  await assert.rejects(
    request({ host: '127.0.0.1', port: 9, path: '/a\r\nX: y', timeoutMs: 100 }),
    { kind: ERROR_KINDS.PROTOCOL },
  );
});

test('Digest over a real server: answered, the challenge kept; a wrong password is a refusal', async (t) => {
  let nonce = 'abc123';
  const check = (r) => {
    const h = r.headers.authorization ?? '';
    const f = Object.fromEntries(
      [...h.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)].map((m) => [m[1], m[2] ?? m[3]]),
    );
    const ha1 = md5(`gladys:esp32-lib:right`);
    const ha2 = md5(`${r.method}:${r.path}`);
    return (
      f.nonce === nonce && f.response === md5(`${ha1}:${nonce}:${f.nc}:${f.cnonce}:auth:${ha2}`)
    );
  };
  const srv = await httpServer({
    routes: {
      '/info/name': (r) =>
        check(r)
          ? { uid: 'Xy7Kq' }
          : reply(401, '', {
              'www-authenticate': `Digest realm="esp32-lib", qop="auth", nonce="${nonce}"`,
            }),
    },
  });
  t.after(() => srv.close());
  const client = new WarpClient();
  const address = { host: srv.host, port: srv.port };
  const auth = { user: 'gladys', password: 'right' };
  assert.deepEqual(await client.get(address, auth, '/info/name', { timeoutMs: 2000 }), {
    uid: 'Xy7Kq',
  });
  const before = srv.requests.length;
  await client.get(address, auth, '/info/name', { timeoutMs: 2000 });
  assert.equal(srv.requests.length, before + 1, 'the kept challenge answered at once');
  nonce = 'renewed';
  await client.get(address, auth, '/info/name', { timeoutMs: 2000 });
  // The kept challenge refused with the same nonce (password changed on the charger): one request.
  const count = srv.requests.length;
  await assert.rejects(
    client.get(address, { user: 'gladys', password: 'changed' }, '/info/name', { timeoutMs: 2000 }),
    (err) => err.kind === ERROR_KINDS.AUTH && err.refused === true,
  );
  assert.equal(srv.requests.length, count + 1);
  await assert.rejects(
    client.get(address, { user: 'gladys', password: 'wrong' }, '/info/name', { timeoutMs: 2000 }),
    (err) => err.kind === ERROR_KINDS.AUTH && err.refused === true,
  );
  assert.ok(!JSON.stringify(srv.requests).includes('right'));
});
