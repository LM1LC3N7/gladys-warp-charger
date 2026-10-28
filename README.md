# gladys-warp-charger

[Gladys Assistant](https://gladysassistant.com) external integration for
**Tinkerforge WARP** EV chargers (WARP1 to WARP4, firmware 2.x) through their
local HTTP API: state, connector and charging state, vehicle plugged in,
power, current allowed, energy of the session, energy index (behind a
plausibility guard), charge mode; a stop held back by no option, read,
command nor pause; start and the charging current behind an off-by-default
option. **Never tested with a real charger. Not affiliated with
Tinkerforge.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (WarpApp)
                                  ├─ src/lane.js           one HTTP exchange at a time (the stop first)
                                  ├─ src/warp/client.js    GET/PUT of a topic, Digest (src/warp/digest.js)
                                  ├─ src/warp/http.js      the only network access (node:http, bounded)
                                  ├─ src/warp/model.js     the answers of the topics (own fields, exact types)
                                  ├─ src/devices.js        the device and its states (pure)
                                  ├─ src/guard.js          energy index guard (gladys-p1-monitor's, as is)
                                  ├─ src/publisher.js      states within 300/min, nothing older than 2 min
                                  └─ src/store.js          /data/warp-state.json (stop, index guard, pauses; no secret)
```

- **Topics** (docs.warp-charger.com, API reference): `info/name` (identity,
  first in every read), `evse/state` and `evse/slots` (the core of a read);
  secondary, never blocking: `info/version`, `meters/0/value_ids` and
  `meters/0/values` (MeterValueIDs 74, power, and 209, energy drawn since
  manufacturing), `charge_tracker/current_charge` (only `user_id` and
  `meter_start`: the user and the NFC tag of the session are never kept nor
  logged),
  `evse/external_enabled` with `evse/external_current` or
  `evse/global_current`, `power_manager/charge_mode`. Written:
  `evse/stop_charging`, `evse/start_charging` (body `null`),
  `evse/external_current` or `evse/global_current`.
- **Credentials**: none, or a user of the charger (HTTP Digest, realm
  `esp32-lib`: the password never travels). A 401 blocks the reads for
  15 min, 1 h, then 6 h (kept in `/data`), lifted by new credentials.
- **Reads**: every 30 s (10 s – 10 min), never sooner (button, scan,
  reconnection, restart: the time of the last read is in `/data`) but the
  reads 5 and 20 s after a command; failures
  retried after 30 s, 1, 2, 5 min, never under the interval; 429 and 5xx of
  the core pause, kept in `/data`.
- **Device**: `ext:<selector>:warp:<uid>` (base58 UID of the charger, case
  kept), never the IP address. The energy index is an `energy-sensor/index`
  through `src/guard.js` on the session clock.
- **Stop**: `evse/stop_charging` (the button slot at 0), never behind the
  option, a read, a command, a pause, a block or the configuration; kept in
  `/data` until seen applied, checked every 15 s, sent again 3 times at most,
  never let go by time.
- **Commands**: start and current behind `allow_commands` (off), decided on a
  fresh read, bounded (6 A to min(ceiling, cable limits)), confirmed by a read
  back; `evse/global_current` is kept in flash: one increase a minute.

## Credits

The API comes from the official documentation of Tinkerforge
(docs.warp-charger.com); parts of the logic are ported from
[HomeAssistant-Tinkerforge-Warp-Wallbox-Custom-Component](https://github.com/oMtQB4/HomeAssistant-Tinkerforge-Warp-Wallbox-Custom-Component)
(Jan Roters, MIT, 2.0.2). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Modelled on the sibling integrations
[gladys-openevse](https://github.com/LM1LC3N7/gladys-openevse) and
[gladys-keba](https://github.com/LM1LC3N7/gladys-keba); the index guard is the
one of [gladys-p1-monitor](https://github.com/LM1LC3N7/gladys-p1-monitor).

## Development

```bash
npm install
npm test                                        # node --test, no network but loopback
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run cover                                   # cover.png, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

The charger is a fake behind the injected transport (`test/fixtures/fakeWarp.js`)
on the virtual clock of the kit; `test/http.test.js` and
`test/realclock.test.js` run the real transport against loopback servers.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from an MIT project, credited
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also shipped in the
Docker image).
