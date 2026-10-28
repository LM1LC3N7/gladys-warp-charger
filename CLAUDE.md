# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/app.test.js              # one file
node --test --test-name-pattern "pause"   # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect(), a stop kept in /data sent at boot
src/handlers.js                   SDK handlers -> WarpApp (shared with the tests)
src/app.js                        polling, device, states, status, index guard, commands, the stop
src/lane.js                       one HTTP exchange at a time; the stop first (it aborts the holder)
src/devices.js                    device and states of the charger (pure); feature roles are frozen
src/guard.js                      energy index guard (gladys-p1-monitor's, as is)
src/warp/client.js                GET/PUT of a topic, Digest challenge kept (no secret)
src/warp/digest.js                RFC 2617 Digest (MD5, qop auth), hostile challenges refused
src/warp/http.js                  one bounded HTTP exchange (node:http), `beforeSend`, abort, error kinds
src/warp/model.js                 the answers of the topics (pure parsers)
src/store.js                      /data/warp-state.json: stop, last read, index guard, pauses, block, flash time; no secret
src/publisher.js                  states to Gladys within 300 per minute, nothing older than 2 minutes
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       English and French runtime texts
scripts/cover.mjs                 cover.png generator (plain Node, no dependency)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys and test/fixtures/fakeWarp.js
test/kit/                         gladys-testkit files, as is (clocks, loopback servers)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Device `gladys.externalIds('warp', uid)`, the
  base58 UID of `info/name` (case kept), never the address nor the host name.
  Feature roles in `FEATURES` of `src/constants.js`, manifest keys
  (`host`, `username`, `password`, `allow_commands`, `max_current`,
  `poll_interval`, `language`, the actions `test_connection` and
  `accept_held_index`).
- **The container rootfs is read-only.** Write only under `/data`. Never log,
  store or show the user name or the password; the Digest challenge kept is
  the charger's nonce, never a hash of the password. Never read more of
  `charge_tracker/current_charge` than `user_id` and `meter_start` (it names
  the user and the NFC tag). A `secret` field is "kept by Gladys in its
  database, never shown again", never "encrypted".
- **Topics from the official API reference only** (docs.warp-charger.com,
  firmware 2.x): `TOPICS` in `src/constants.js`, nothing else read or written.
- **One HTTP exchange at a time** (`src/lane.js`): a new connection opens
  only once the previous socket is closed (`src/warp/http.js` settles then).
- **The stop** (`evse/stop_charging`): never behind the option, the bounds, a
  read, a command, a pause, a block, a missing configuration; it aborts what
  holds the line; a command that arrived before it and has not left gives
  way; kept in `/data` before its first byte (200 ms at most, a failing disk
  never holds it); checked every 15 s, sent again 3 times at most; let go
  only when applied (button slot 0), no vehicle, or a newer start left; a
  start sent less than 90 s before it is watched for. Never ended by time.
- **Commands** (start, current): never a switch or a writable binary;
  refused unless `allow_commands`, checked on arrival and in `beforeSend`;
  decided on a fresh read (identity included); bounded 6 A to min(ceiling,
  cable limits); start refused when the charger would give more than the
  ceiling; confirmed only by a read back equal to the value asked;
  `evse/global_current` (flash) one increase a minute, its time in `/data`
  before the byte (a failed save refuses).
- **Energy index**: only through `src/guard.js` on the session clock; never
  0, never a drop nor a jump without the user (two clicks, bounded).
- **Clocks**: monotonic for every in-memory time; the session clock for the
  guard; the wall clock for /data only.
- **Never read sooner than the interval** (button, scan, reconnection,
  restart); only the follow-up reads after a command (5 s, 20 s).
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` by hand (0.1.0 was set by hand once, see TODO.md).
- **Changelog**: every user-visible change adds a line under
  `## [Unreleased]`.
- **Manifest** texts are `{ "en", "fr" }`; `test/manifest.test.js` ties the
  manifest to the code. Files are UTF-8 without BOM.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback servers only).
