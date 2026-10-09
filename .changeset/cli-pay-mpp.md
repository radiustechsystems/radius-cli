---
'radius-cli': minor
---

`wallet pay` also pays MPP (`WWW-Authenticate: Payment`, `evm` charges). `--protocol auto|x402|mpp` (default `auto`: x402 when a server offers both) chooses, and the JSON `payment` object gains `protocol`. Messages are now prefixed `pay:` instead of `x402:`.
