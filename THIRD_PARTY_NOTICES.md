# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

## WARP charger API

The topics read and written (`src/constants.js`, `src/warp/model.js`), their
fields, units and meanings come first from the official documentation of the
WARP chargers' MQTT/HTTP API by Tinkerforge GmbH
(<https://docs.warp-charger.com>, Interfaces, API reference, sources in
<https://github.com/Tinkerforge/warp-charger>, read at commit `c95ecff` of
2026-10-27) and the MeterValueID table of the WARP firmware. Nothing of that
documentation is copied here beyond the names of the topics, fields and enum
values an API client needs.

They were checked against **HomeAssistant-Tinkerforge-Warp-Wallbox-Custom-Component**
2.0.2 (<https://github.com/oMtQB4/HomeAssistant-Tinkerforge-Warp-Wallbox-Custom-Component>,
commit `586726c` of 2026-10-21, MIT, Jan Roters), a Home Assistant
integration for the same chargers, from which this integration ports parts
of its logic to JavaScript: the topics it polls, the start and stop commands
sent with a `null` body, the Digest authentication of the HTTP API, the
MeterValueIDs of the power and of the energy drawn, the charger states and
the charge modes of `power_manager/charge_mode` (the "default" mode being a
resolver, not a mode), the session energy from
`charge_tracker/current_charge`. No Python code runs here and that component
is not a dependency. This port was modified: written in JavaScript, every
read and write bounded in time and size, one request at a time, a stop that
is never held back, commands behind an option, no WebSocket, no firmware
update, no NFC, no other topic.

Tinkerforge and WARP are trademarks of their owner. This project is not
affiliated with, endorsed by or supported by Tinkerforge GmbH.

The license of HomeAssistant-Tinkerforge-Warp-Wallbox-Custom-Component, in full:

```
MIT License

Copyright (c) 2026 Jan Roters

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Code of the same author

`src/guard.js` is the energy index guard of **gladys-p1-monitor** 0.1.4
(<https://github.com/LM1LC3N7/gladys-p1-monitor>, Apache-2.0, same author),
taken as is. `test/kit/` holds files of **gladys-testkit** (Apache-2.0, same
author), reused as is.
