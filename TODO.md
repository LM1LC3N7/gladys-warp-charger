# TODO — WARP Charger v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, Node 22 and 24, Docker,
  store validator), `npm run audit`, then update README, `docs/en.md`,
  `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum post from a module session: the batch reserved in /t/10385
  (lot 18) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No `keywords` nor `countries` in the manifest yet (the core has not
  shipped them).

## Status

- [x] **Milestone 1 — core** (2026-10-28): one charger by address, optional
      Digest credentials, one device per UID, state, connector, charging
      state, plugged, power, current allowed, session energy, energy index
      behind the guard of gladys-p1-monitor (session clock, two clicks),
      charge mode, fault; stop never held back (kept in `/data`, checked
      every 15 s, 3 resends at most, watched for a late start); start and
      current behind `allow_commands`; secondary topics never blocking;
      never read sooner than the interval; docs en/fr, cover. Tested against
      a fake built from the API reference only.
- [ ] **Milestone 2 — real charger**: run against a real WARP (see "To
      check"), turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: the WebSocket (`/ws`, pushed states instead of
      polling), HTTPS with a pinned certificate, the charge mode as a command
      (behind the option: "fast" starts a charge), phases, several chargers.

## To check on a real charger

- The time between `evse/stop_charging` and `evse/slots[4].max_current`
  reading 0 (the read back waits 600 ms; a slower controller gives "not
  applied yet", then the 15 s check confirms).
- The answer of a PUT (200 with an empty body?) and of a refused one (400
  with a text?).
- Digest: whether the firmware accepts a nonce again with a growing `nc`
  (the client keeps the challenge; a 401 to it is answered once with the
  new one).
- `evse/slots` length on WARP1 (the reference shows 15 to 18 entries).
- `meters/0/values` before the meter answered (nulls: read as unknown).
- `charge_tracker/current_charge.meter_start` null at the start of a session.
- A charger in "HTTPS only" mode: the 301/308 of HTTP (said in the status).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-warp-charger:0.1.0`): the first Release (patch)
  gives 0.1.1. SDK `^0.16.0` (latest published, 2026-10-25; changelog read:
  nothing this module relies on changed).
- **Reference**: the official API reference (docs.warp-charger.com, sources
  in Tinkerforge/warp-charger at `c95ecff`, 2026-10-27) first, then
  HomeAssistant-Tinkerforge-Warp-Wallbox-Custom-Component 2.0.2 (MIT, Jan
  Roters, `586726c`), cloned read only in `~/code/ref/lot18/warp-ha`. The
  firmware source (esp32-firmware) was only read to check the behaviour of
  `evse/start_charging`/`stop_charging` (no effect while no vehicle is
  plugged in) and the slot numbers; nothing is ported from it.
- **HTTP only** in v1 (the documentation's default, port 80): an `https://`
  address or a redirect is said in the status. HTTPS needs a pinned
  certificate (milestone 3).
- **Polling only** in v1 (no WebSocket): one request at a time, the ESP32
  serves few connections. `info/name`, `evse/state`, `evse/slots` are the
  core; the other topics are secondary (a failure leaves them unread, tried
  again after 2x the interval, doubling up to 1 h; a 404 after 1 h). A 5xx
  or a 401 on a secondary topic is not a pause nor a refusal; a 429 anywhere
  pauses.
- **The stop is `evse/stop_charging`** (the button slot 4 at 0), applied by
  the read back of `evse/slots` (slot 4 at 0) or no vehicle (IEC state A:
  the firmware ignores the stop then, nothing charges). Slot 4 has only two
  values (0 or 32 A), so "changed elsewhere" cannot be told from "not
  applied": a stop not applied is sent again 3 times at most (writes the
  charger accepted, one per 15 s check), then held without writes, said in
  the status, until a new click, the slot at 0, no vehicle, or a newer start
  from Gladys. Never by time. A start that left less than 90 s before the
  stop keeps the stop watched until then (a late start is countered).
- **The stop without the configuration**: to the address of the last charger
  read (`target` in `/data`), without credentials (they are never in
  `/data`): with users on the charger, it gets a 401 until Gladys answers;
  it is kept and sent again at once when the configuration arrives.
- **The current**: the external control slot (`evse/external_current`, RAM)
  when `evse/external_enabled`, else `evse/global_current` (kept in the
  flash of the charger: one increase a minute, its time in `/data` before
  the byte, a failed save refuses; a decrease is never limited). Bounds: 6 A
  to min(ceiling 16 A by default / 32 A at most, active cable slots 0 and 1).
- **Start bounded by the ceiling**: refused when the lowest active slot
  other than the button would give more than the ceiling (the user sets the
  current first). No automatic lowering (two writes, a setting changed
  behind the user).
- **Energy index**: MeterValueID 209 (active energy drawn since
  manufacturing, kWh) as `energy-sensor/index` through the guard of
  gladys-p1-monitor 0.1.4 as is (25 kW, 0.5 kWh slack), on the session
  clock; the session energy (209 minus `meter_start`) a plain sensor; the
  power (74, draw minus feed) a signed `energy-sensor/power`.
- **The charge mode** is read only in v1 (`fast` would start a charge: a
  command for later, behind the option).
- **Credentials**: Digest only (the firmware's); a user name with a colon or
  a quote is refused. 401 on a core topic blocks the reads 15 min, 1 h,
  6 h (in `/data`); new credentials lift it at once.
- **Test files**: `test/kit/` holds gladys-testkit files as is (excluded from
  Prettier); `certs.mjs` is a stub (no test certificate in the repo).
- **Mutation check** (2026-10-28): 51 mutants of the guards (option on
  arrival and in `beforeSend`, stop sequence, stop retries, resends, watch,
  `/data` before the byte, quarantine, bounds, ceiling, flash minute and
  save, read back, guard 0, freshness, secondary topics, never sooner,
  Digest refusal, lane abort, identity, credentials per address...), all
  killed by the tests. One duplicate abort of the line at the stop click was
  removed (the lane aborts the holder when the stop asks for it).
