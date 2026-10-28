# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-28

### Added

- Tinkerforge WARP chargers (WARP1 to WARP4, firmware 2.x) read over their
  local HTTP API (no cloud), with or without a user of the charger (HTTP
  Digest): one device, keyed by the UID of the charger.
- State, connector and charging state (charging-station category), vehicle
  plugged in, power, current allowed, energy of the session (plain sensor),
  charge mode, fault (read only); the meter, the session, the current set and
  the charge mode never hold the other values back.
- The energy drawn as an energy index (kWh) behind the guard of
  gladys-p1-monitor on the session clock: never 0, jumps and drops held back
  (kept in `/data`, never confirmed by time) until "Accept the held index", in
  two clicks bounded to what was shown.
- A stop button never held back (option, reads, commands, pauses, refused
  credentials, configuration not read, restart), kept in `/data` until seen
  applied.
- A start button and a charging current list (6 A to a ceiling of 16 A by
  default, and the cable limits) behind "Allow the commands" (off by
  default), decided on a fresh read, confirmed by a read back; one increase
  of the flash-kept current a minute.

[Unreleased]: https://github.com/LM1LC3N7/gladys-warp-charger/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-warp-charger/releases/tag/v0.1.1
