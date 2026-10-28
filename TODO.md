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

- **Review r3 (2026-10-28)**: B3, a start lets a kept stop go only when no
  stop was clicked after it arrived (`entry.seq === protectSeq`), on its 2xx
  and on a failure without a clear refusal: a stop clicked while a start is
  on the line cuts it, stays kept and counters it if it lands late. I4: tests
  for a start that never left, a 401 and a 429 (the stop kept, sent again at
  the check). Also: the end of a stop never awaits /data (the next check
  armed first): a hung disk no longer stalled the stop worker, its checks
  and every later click; the check after a stop in 'watch' at the end of the
  watch is tested. Mutants "no watch of a late start (stop)" and "no watch
  on a check resend" left: equivalent. `lastStartAt` moves only in the
  `beforeSend` of a start whose `seq` is the current one (an older one is
  refused there), so after a click only a start clicked later can move it;
  it then lets the stop go, unless clearly refused (not applied: no start to
  watch for). The watch set at the click covers every start before it.

- **Review r2 (2026-10-28)**: I3, a newer start that left lets a kept stop go
  unless clearly refused (401, other 4xx, 429, 3xx): a 5xx, a silence or a
  cut let it go (the start may be applied); while a stop is kept, Start is
  always written (never "already so"). m1: tests for the wait under the line
  aborted by a stop, the re-arming on 'wait' and 'yield', a start allowed by
  an external control under the ceiling. m2: the docs say the external
  controller may raise slot 8 after a start. A stop never written in /data
  reads 0 resends. Reviewer mutant "M5 start with cables unknown" left:
  equivalent (`capFixed` is undefined then).

- **Review r1 (2026-10-28)**:
  - B1: a command never waits without a bound while it holds the line: the
    save of `flashAt` runs against the send deadline and the stop (late:
    "nothing sent"), the 429 pause is saved without being awaited, the wait
    after a write ends when a stop takes the line; `protect()` waits 200 ms
    at most for /data.
  - B2: every exit of the check of the stop ends in one place: let go on
    'done', the next check armed (1 s on 'yield', the end of the watch on
    'watch', `sentAt + 2 s` on 'wait', 15 s else) before /data is written.
  - I1: a restart keeps `written` and `resends` of /data; a stop held (written,
    3 resends) is only checked, never sent by a restart; a boot send of a stop
    written before counts as a resend. A stop never written is always sent.
  - I2: tests for the 200 ms wait, the 429 retry, the answer by 4.3 s, the
    resends given back by a new click.
  - M1: an acceptance is bounded below both ways (a drop accepted is the
    floor; the guard is no longer p1-monitor's as is, said in its header).
  - M2: a start lets a kept stop go only on its 2xx.
  - M3: the start ceiling is checked on the fixed slots (cables 0 and 1,
    global 5, external 8): a dynamic slot low now never lets a start through.
  - M4: the unit pairs frozen in the test (runs under Node 22 too). M5: a
    cable slot that cannot be read refuses start and current.
  - Also: a kept stop is checked at once by the test button (a stop that never
    left is never given up), and watched for a start sent less than 90 s
    before the click even when the click writes nothing.
  - Reviewer mutants left: "never written counts as written" and "no watch
    on a check resend" are equivalent now (a restart always sends a stop
    never written; the watch is set at the click); s4 "start allowed with the
    charge manager at 6 A" is refused on purpose (M3).

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
