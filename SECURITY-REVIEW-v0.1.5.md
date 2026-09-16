# Security review — radius-cli v0.1.5

**Date:** 2026-09-16
**Scope:** `radius-cli` client-side code. Primary target `main` @ `5a6d6a4`; deltas from the
released `v0.1.5` tag (`60e06f9`) are called out where they matter.
**Out of scope:** the x402 proxy contracts, Permit2, SBC/RUSD tokens, the Turnstile, and the
facilitator service. These are treated as trusted-but-noted.
**Method:** full manual read of all 22 source files, plus local proof-of-concept harnesses
(mock JSON-RPC + hostile x402 origin) run against the built CLI. No live network, no funds.

## Release note

`main` is **ahead of the v0.1.5 tag** by a security-relevant change. PR #19 (`fd73f72`,
"Grant Permit2 an unlimited one-time approval instead of exact-amount") landed after the
release. v0.1.5 as published grants an exact-amount Permit2 approval; `main` grants
`MaxUint256`. See M-1.

## Threat model

| # | Adversary | Capability |
|---|---|---|
| A1 | Malicious or compromised x402 origin | Controls the 402 challenge: asset address, amount, payTo, network, scheme, EIP-712 domain hints, facilitator, redirects, and the response body |
| A2 | Local attacker / malware / backup-and-sync | User-level read of `~/.radius`, process table, shell history |
| A3 | Supply-chain attacker | The npm publish path |

The asset at risk is the private key and, through it, every token the wallet holds.

## Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| H-1 | High | `--x402-threshold` caps units of a **server-chosen asset**, not value | PoC confirmed |
| H-2 | High | Payment prompt is spoofable and hides the asset address | PoC confirmed |
| H-3 | High | Passwordless keystore, auto-created by read-only commands | PoC confirmed |
| H-4 | High | Paid response body truncated at 64 KiB when piped | PoC confirmed |
| M-1 | Medium | Unlimited Permit2 approval on a server-chosen contract (post-release regression) | Code review |
| M-2 | Medium | `-y` conflates "pay anything" with "grant unlimited approval" | Code review |
| M-3 | Medium | Custom credential headers leak cross-origin on redirect | PoC confirmed |
| M-4 | Medium | 402 challenge honoured from a redirected origin; `resource` never validated | Code review |
| M-5 | Medium | Private key and password exposed via argv / env | Code review |
| M-6 | Medium | Keystore mode not enforced on overwrite; non-atomic write risks key loss | PoC confirmed |
| M-7 | Medium | `RADIUS_PASSWORD` bypasses the password policy entirely | PoC confirmed |
| M-8 | Medium | Gas price taken from RPC unbounded, never shown before signing | Code review |
| M-9 | Medium | Displayed address read from keystore JSON, not derived from the key | Code review |
| M-10 | Medium | No CI, no npm provenance, manual publish from a developer machine | Repo inspection |
| M-11 | Medium | `package.json` points at a non-existent GitHub org | Repo inspection |
| L-1…L-8 | Low | See below | |

---

## High

### H-1 — `--x402-threshold` caps units of a server-chosen asset, not value

`src/commands/walletX402.ts:415-433`, `src/lib/x402/eip3009.ts:37-83`

`decideAutoPay` converts the threshold with `parseUnits(threshold, decimals)` and auto-pays when
`limit >= accept.maxAmountRequired`. Both `decimals` and the asset identity come from
`accept.asset` — **an address chosen by the server**. Nothing constrains it to SBC, RUSD, or any
allowlist.

The README states: *"`0.05` means 0.05 SBC, which is $0.05 since SBC is USD-pegged"*. The actual
guarantee is "0.05 units of whatever token the server names, if you hold it." A server that names
an 18-decimal token worth $3,000/unit turns a `--x402-threshold 0.05` policy into a $150 payment —
a 300,000% overrun, with no prompt.

This is the control the README recommends **for AI agents and other non-interactive use**, which is
exactly the setting with no human to catch it.

**PoC** — hostile origin names asset `0x1111…1111` (18 decimals, `symbol()` → `"SBC"`), requests
`5e16` atomic units. User runs `--x402-threshold 0.05`:

```
$ radius-cli wallet x402 get http://…/r --x402-threshold 0.05 --network testnet
x402: paid 0.05 SBC (tx 0xdead)
```

The signed EIP-3009 authorization actually emitted:

```json
{ "from": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "to":   "0x2222222222222222222222222222222222222222",
  "value": "50000000000000000" }
```

**Fix.** Constrain payable assets to an allowlist (SBC/RUSD by default, extensible via
`--x402-asset` / config), and refuse any challenge naming an asset outside it. If arbitrary assets
must be supported, express the threshold in a canonical unit and require an explicit per-asset
opt-in. Bound `decimals` to a sane range.

### H-2 — Payment prompt is spoofable and hides the asset address

`src/commands/walletX402.ts:174, 190-200, 435-455`

`const symbol = asset.symbol ?? accept.asset;` reads `symbol()` from the server-chosen contract.
The confirmation prompt is:

```
Pay 0.05 SBC to 0x2222…? (balance: 1000 SBC)
```

Every field here is attacker-influenced, and the **asset contract address is never shown**. A
malicious token returning `symbol() = "SBC"` renders a prompt indistinguishable from a legitimate
one. The same applies to `writeChallengeSummary`. Interactive confirmation therefore provides no
defence against H-1 — the two findings compound.

The `upto` prompt additionally omits the facilitator address, which is the party being granted
settlement discretion.

**Fix.** Show the asset contract address (and a trusted/untrusted marker), the scheme, the
deadline, and for `upto` the facilitator. Never render a server-supplied symbol as though it were
identity — render it as `"SBC" (0x1111…1111)`.

### H-3 — Passwordless keystore, auto-created by read-only commands

`src/lib/account.ts:27-49`, `src/lib/config.ts:88-94`

`autoCreateKeystore` uses `cfg.password ?? ''` — an **empty password**. It is triggered by
`getOwnAddress`, so a command as innocuous as `wallet address` mints a mainnet-capable key:

```
$ radius-cli wallet address
Created new keystore at ~/.radius/keystore.json
No password set — keystore is effectively unencrypted (file mode 0o600).
```

Confirmed trivially decryptable:

```
Wallet.fromEncryptedJson(json, "") -> privateKey=0x829eab57…
```

`passwordless: true` is then persisted to `config.json`, so `resolvePassword` never prompts again.
File mode `0600` is the only control, which fails against home-directory backup, cloud sync,
container image layers, and any process running as the user.

The warning text is honest, but it is printed *after* the key exists, on stderr, during a command
the user ran for something else.

**Fix.** Do not auto-create on read paths — `wallet address` should fail with "no wallet; run
`wallet new`". If auto-create is kept for UX, gate mainnet on a real password and reserve the
passwordless default for testnet.

### H-4 — Paid response body truncated at 64 KiB when piped

`src/commands/walletX402.ts:457-473, 316-317`

`emit()` calls `process.stdout.write(res.body)` and the caller immediately calls `process.exit()`.
Node's stdout is **asynchronous when it is a pipe**; `process.exit` does not flush pending writes.

The README advertises exactly this workflow: *"Body goes to stdout … pipeable"* and
*"Useful for piping into `jq`"*.

**PoC** — server returns 1 MiB of paid content:

```
$ radius-cli wallet x402 get http://…/r -y | wc -c
65536          # 94% of the paid-for content silently lost, exit code 0

$ radius-cli wallet x402 get http://…/r -y > out.bin ; wc -c < out.bin
1048576        # correct when stdout is a file (sync writes)
```

The payment settles on-chain regardless. The user pays in full and receives 64 KiB, with no error
and a success exit code. `--json` envelopes are affected identically. This also silently corrupts
any agent pipeline built on the documented pattern.

**Fix.** Set `process.exitCode` and let Node exit naturally, or `await` a callback/`drain` before
exiting. Audit every `process.exit()` after a write — `walletX402.ts` has nine.

---

## Medium

### M-1 — Unlimited Permit2 approval on a server-chosen contract *(post-v0.1.5 regression)*

`src/commands/walletX402.ts:385-403`. Introduced by PR #19, **not in the v0.1.5 tag**.

```js
args: [CANONICAL_PERMIT2_ADDRESS, maxUint256],
…
to: accept.asset,          // server-chosen
```

Two concerns. First, the approval target `accept.asset` is server-chosen, so the CLI will submit a
user-funded transaction to an arbitrary contract. Second, and more importantly, chaining with H-1
means a user can be walked into granting an **unlimited** Permit2 allowance on a legitimate,
valuable token they hold. Before PR #19 the allowance was exact-amount, so the blast radius was
one payment; now it is the full balance, permanently, bounded only by Permit2's own signature
checks.

The in-code rationale (the x402 spec's "one-time gas approval" model) is sound *given* a trusted
asset. It is not sound when the asset is attacker-chosen. Fixing H-1 largely resolves this; until
then the change strictly increases risk relative to the shipped release.

**Fix.** Gate unlimited approval on an allowlisted asset. For non-allowlisted assets use
exact-amount, or refuse. Show the token address in the approval prompt.

### M-2 — `-y` conflates two distinct authorizations

`src/commands/walletX402.ts:362` — `const auto = subOpts.yes || subOpts.x402ApprovePermit2;`

`-y` means both "pay any amount without prompting" and "grant an unlimited token approval without
prompting." These have very different blast radii and should not share a flag. Keep `-y` for
payment and require `--x402-approve-permit2` explicitly for approvals.

### M-3 — Custom credential headers leak cross-origin on redirect

`src/lib/x402/http.ts:55-76` — the initial request uses `redirect: 'follow'` unconditionally.

undici strips `Authorization` per the fetch spec, but **not** custom headers. Confirmed:

```
$ radius-cli wallet x402 get http://good/r -H 'Authorization: Bearer SECRET-TOKEN' \
                                           -H 'X-Api-Key: SECRET-API-KEY'
EVIL RECEIVED HEADERS: {"authorization":null,"x-api-key":"SECRET-API-KEY"}
```

`X-Api-Key`, `X-Auth-Token` and friends are extremely common. **Fix:** use `redirect: 'manual'` on
the initial request too and re-attach headers only on a same-origin hop, or drop user headers
across origins.

### M-4 — 402 challenge honoured from a redirected origin; `resource` ignored

`src/commands/walletX402.ts:114-130`. Because the initial request follows redirects, the 402 may
originate from an origin the user never named, and nothing records or checks that. Separately,
`parseChallenge` parses `accept.resource` (`protocol.ts:133`) and **never compares it to the
request URL**, so the spec's resource binding is unenforced. The paid retry *is* correctly
protected against cross-origin replay (`walletX402.ts:240-248`) — that part is well done.

**Fix.** Require the 402 to be same-origin with the requested URL, and validate `resource` against
it before signing.

### M-5 — Private key and password exposed via argv and env

`--private-key 0xHEX` and `wallet import 0xPRIVATE_KEY` (the documented flow) place key material in
`argv`, readable from `/proc/<pid>/cmdline` by other local users on default Linux, and captured in
shell history. `RADIUS_PASSWORD` is better (`/proc/<pid>/environ` is owner-only) but still
inherits to children and lands in CI logs.

**Fix.** Accept the key on stdin or from a file (`--private-key-file`, `--private-key -`), keep
the argv form for testnet only or warn loudly, and document the exposure.

### M-6 — Keystore mode not enforced on overwrite; non-atomic write risks key loss

`src/lib/keystore.ts:11-20`. `writeFileSync(path, json, { mode: 0o600 })` applies the mode **only
at creation**. Confirmed — a pre-existing `0644` keystore stays `0644` after `wallet new --force`:

```
-rw-r--r--  keystore.json   (before)
-rw-r--r--  keystore.json   (after wallet new --force)
```

Separately, `writeFileSync` truncates before writing, with no temp-file-and-rename and no `fsync`.
A crash mid-write on `wallet import` / `wallet new --force` destroys the only copy of the key.

**Fix.** `chmodSync` after write (or `openSync` with an explicit mode). Write to a temp file in the
same directory, `fsync`, then `rename`.

### M-7 — `RADIUS_PASSWORD` bypasses the password policy

`src/commands/wallet.ts:66-73`. `readNewPassword` returns `envPassword` immediately, skipping both
the 8-character minimum and the confirmation prompt. Confirmed: `RADIUS_PASSWORD=x` creates a
single-character keystore, and `RADIUS_PASSWORD=` creates an empty-password keystore via explicit
`wallet new` **with none of the warnings** the auto-create path prints.

**Fix.** Apply the same policy to the env path, or require an explicit
`--allow-weak-password` / `--passwordless` opt-in.

### M-8 — Unbounded gas price, never shown before signing

`wallet.ts:378, 404, 436` and `walletX402.ts:395` all do `await publicClient.getGasPrice()` and
pass the result straight into `sendTransaction`, with no sanity bound and no display. A malicious
or misconfigured RPC (reachable via `--rpc-url`, `RADIUS_RPC_URL`, or a tampered `config.json`)
can return an enormous gas price and drain the RUSD balance in fees. The user never sees the fee
before it is spent — table stakes for a wallet.

**Fix.** Display the estimated fee in the confirmation, add `--max-gas-price`, and apply a
sanity ceiling.

### M-9 — Displayed address read from keystore JSON, not derived from the key

`src/lib/keystore.ts:37-46`. `readKeystoreAddress` parses the `address` field out of the JSON
without decrypting. For a **password-protected** keystore this is a real attack: someone who can
write the file but cannot decrypt it can swap the displayed address, and `wallet address` /
`wallet balance` / `wallet verify` will report an address the user does not control — funds get
sent to the attacker. (Under the H-3 passwordless default it adds nothing, since write access
already implies key access.)

Also note `readCachedAddress` (`config.ts:70-73`) is dead code, and the README's claim that the
address is served from `config.json` does not match `getOwnAddress`.

**Fix.** Derive the address from the decrypted key, or cross-check the JSON field against a
decryption on any security-relevant path.

### M-10 — No CI, no provenance, manual publish

There is no `.github/` directory: no tests on PR, no lint, no release workflow, no npm provenance,
no signed tags. `prepublishOnly` builds from whatever is on the maintainer's disk, and the release
carries no attached artifacts — the real artifact is an npm tarball with no attestation. For a
wallet, this is the weakest link in the whole review.

**Fix.** Add a CI workflow (build + `npm test` + `npm audit`) on PR; publish from CI with
`npm publish --provenance`; require 2FA; sign release tags.

### M-11 — `package.json` points at a non-existent GitHub org

`repository`, `homepage`, and `bugs` all reference `github.com/radiustech/radius-cli`; the real
repo is `radiustechsystems/radius-cli`. The npm page therefore links to a repo the publisher does
not control, which breaks provenance for anyone verifying the package and leaves an
impersonation/typosquat slot open for whoever registers that org.

---

## Low

- **L-1 — Server-supplied EIP-712 domain.** `readAssetInfo` (`eip3009.ts:60-80`) prefers
  `extra.name` / `extra.version` from the challenge over the on-chain values, so the CLI signs a
  domain it never verified. Not directly exploitable (`verifyingContract` is still the asset, so a
  wrong domain just yields an invalid signature), but it removes a free integrity check. Read both
  on-chain and reject mismatches.
- **L-2 — First acceptable offer wins.** `walletX402.ts:134-141` breaks on the first compatible
  `accepts` entry rather than the cheapest. A server can order an expensive option first. Select
  the minimum-cost compatible offer.
- **L-3 — No request timeout.** No `AbortSignal` on `fetch`, none on
  `waitForTransactionReceipt`. A hostile origin can hang the CLI indefinitely.
- **L-4 — `rpcUrl` unvalidated.** `config.ts:47` takes `rpcUrl` from flag/env/`config.json` with
  no validation at all (addresses *are* validated), and permits plaintext `http://`. Validate the
  URL and warn on non-HTTPS.
- **L-5 — Raw server bytes to the terminal.** `process.stdout.write(res.body)` and
  `safeBodyPreview` emit unsanitised attacker bytes. `curl` has the same property for stdout, but
  here the stderr previews interleave with an interactive payment prompt, so escape sequences can
  overwrite the text the user is confirming. Strip C0/ANSI from stderr previews when stderr is a TTY.
- **L-6 — Permit2 proxies unverified on Radius.** The hardcoded proxies are **correct** (see
  below), but the upstream deployment table lists Base, Arbitrum, Polygon, Optimism, Avalanche,
  Celo, Linea, Unichain, Monad and World Chain — **not Radius**. Squatting is not a risk (CREATE2
  with fixed initcode means the address implies the bytecode), but if the contracts are not
  deployed on Radius the user grants an unlimited ERC-20 approval and signs a permit naming a
  spender that does not exist. Add a `getCode()` preflight before signing, and confirm deployment.
- **L-7 — `readFacilitator` skips `isAddress`.** `handlers.ts:206-214` casts an arbitrary string to
  `Address`. Confirmed that viem rejects malformed input at signing (`Address "not-an-address" is
  invalid`), so this is defence-in-depth only — but it is inconsistent with the careful `asAddress`
  validation in `protocol.ts` and a checksum-less address passes through.
- **L-8 — Dependency audit.** `npm audit` reports 10 vulnerabilities (1 critical, 4 high). Read
  carefully: **the critical and all four highs are devDependencies** (`vitest`, `vite`, `esbuild`,
  `postcss`, `nanoid`) that are not installed by consumers and not in the `files` allowlist — they
  are a developer-machine concern, not a shipped one. The only runtime-tree issue is `ws` (high,
  DoS + uninitialised memory disclosure) pulled in transitively by both `ethers` and `viem`; the
  CLI uses only the `http()` transport, so no code path reaches it. Bump `viem` (≥2.49.4) and
  `ethers`, and update devDependencies, but neither is an emergency.

---

## Verified correct

Worth stating explicitly, since these are the parts most likely to be wrong:

- **Permit2 witness types match upstream exactly.** `PERMIT2_UPTO_TYPES` matches
  `Witness(address to,address facilitator,uint256 validAfter)` and `PERMIT2_EXACT_TYPES` matches
  `Witness(address to,uint256 validAfter)`, member order included, as verified against
  `x402-foundation/x402` `x402UptoPermit2Proxy.sol` / `x402ExactPermit2Proxy.sol`.
- **Proxy addresses match the upstream canonical table.** `0x402085c248…0001` (exact) and
  `0x4020A4f3b7…0002` (upto) are correct.
- **The Permit2 spender is client-pinned**, not taken from the challenge — a good decision that
  blocks the most obvious attack on this scheme.
- `parseUptoSettlementAmount` correctly rejects a settlement above the authorized maximum.
- `hasSuccessfulPaymentResponse` requires an explicit `success === true`; `summary.paid` also
  requires a 2xx.
- Nonces and keys use `node:crypto` / viem CSPRNGs.
- The **paid retry** uses `redirect: 'manual'` and refuses cross-origin replay of the payment header.
- Header injection via `-H` is blocked by undici; `FORBIDDEN_REQUEST_HEADERS` blocks `host` and
  `x-payment` overrides.
- EIP-3009 and Permit2 deadline windows are clamped to 600s.
- Response bodies are capped at 25 MiB with streaming enforcement.
- The npm `files` allowlist is tight (`dist`, `README.md`, `LICENSE`) — no source or key leakage.
- No secrets in git history (the private keys present are the well-known Hardhat test accounts).

## Recommended order of work

1. **H-1 + H-2 together** — asset allowlist plus an honest prompt. This is the core defect; M-1
   and M-2 shrink substantially once it lands.
2. **H-4** — one-line class of fix, silent financial data loss, affects the documented agent path.
3. **H-3 / M-7 / M-6** — keystore hardening as one change.
4. **M-3 / M-4** — redirect and origin handling.
5. **M-10 / M-11** — CI, provenance, repo metadata.
6. Low findings as cleanup.

Items 1–3 are worth a `v0.1.6` before the CLI is promoted for non-interactive agent use.

## Reproducing

PoC harnesses (mock JSON-RPC + hostile x402 origin) were run against `dist/` built from
`5a6d6a4`. They are not committed; each finding above states the exact command and observed
output. No live network, mainnet, or testnet funds were used.
