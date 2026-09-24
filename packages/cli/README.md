# radius-cli

A CLI wallet for the [Radius Network](https://radiustech.xyz) — modeled on Foundry's `cast`, with a built-in account stored in `~/.radius/keystore.json`.

```bash
npx radius-cli wallet new
npx radius-cli wallet address
npx radius-cli wallet balance
npx radius-cli wallet send 0xRecipient 0.10 RUSD
npx radius-cli call 0xToken "balanceOf(address)(uint256)" 0xUser
```

## Install

```bash
# One-off invocation
npx radius-cli <command>

# Or install globally — the binary on $PATH is `radius-cli`
npm install -g radius-cli
radius-cli wallet address
```

Requires Node ≥ 20.

## Networks

| Network | Chain ID | Default RPC |
|---|---|---|
| `mainnet` *(default)* | 723487 | `https://rpc.radiustech.xyz` |
| `testnet` | 72344 | `https://rpc.testnet.radiustech.xyz` |

Override the URL with `--rpc-url` or `RADIUS_RPC_URL` if you want to point at a different endpoint.

## Wallet

On first use, any account-needing command (`wallet address`, `balance`, `sign`, `send`, …) auto-creates a keystore at `~/.radius/keystore.json` with no password set (file mode `0o600`). To opt into a password, run `radius-cli wallet new --force` (or set `RADIUS_PASSWORD` before the first command). The keystore is Web3 Secret Storage v3 — compatible with geth/foundry. The address is cached in `~/.radius/config.json` so `radius-cli wallet address` is a cheap read.

```bash
radius-cli wallet new
radius-cli wallet import 0xPRIVATE_KEY
radius-cli wallet address
radius-cli wallet balance [0xAddr]
radius-cli wallet export                           # decrypts and prints the private key
radius-cli wallet sign "hello"                     # EIP-191 personal_sign — prints 0x signature
radius-cli wallet sign --raw 0xdeadbeef            # sign raw hex bytes
echo -n "msg" | radius-cli wallet sign -           # read message from stdin
radius-cli wallet verify "hello" 0xSig             # verify against own address
radius-cli wallet verify "hello" 0xSig --address 0xOther
radius-cli wallet send 0xTo 0.10 RUSD              # native value transfer
radius-cli wallet send 0xTo 0.10 SBC               # ERC-20 transfer of SBC
radius-cli wallet send 0xToken "transfer(address,uint256)" 0xTo 100   # arbitrary call
radius-cli --network testnet wallet faucet         # drip test funds into the local wallet
radius-cli --network testnet wallet faucet status  # faucet rate-limit state for the local wallet
```

`--private-key 0xHEX` overrides the keystore on any command.

### Faucet (test funds)

`wallet faucet` requests a drip from the Radius faucet for the configured network (testnet: ~0.5 SBC per request; mainnet: a small daily SBC amount) through [`radius-sdk/faucet`](../sdk#faucet-test-funds). Where the faucet also drips a little RUSD for gas it is reported alongside.

```bash
radius-cli --network testnet wallet faucet                 # drip into the local wallet (alias: wallet faucet fund)
radius-cli --network testnet wallet faucet 0xOther         # drip into another address
radius-cli --network testnet wallet faucet status [0xAddr] # rate-limit state, requests left, drip amounts
radius-cli --network testnet wallet faucet --json          # {faucetUrl, address, token, amount, txHash, explorerUrl, native, nextDripAt}
```

Whether a faucet demands a signed request is a server-side switch (testnet currently does not, mainnet is expected to). The CLI drips unsigned first and, only if the faucet answers `signature_required`, signs its EIP-191 challenge with the local wallet and drips again, so the keystore is unlocked only when actually needed. `--signature always` skips the unsigned attempt; `--signature never` disables the fallback. Dripping into another address can therefore only work while that faucet accepts unsigned requests (it exits 2 with `signer_required` otherwise; pass that address's key with `--private-key` to sign for it). `--token <symbol>` requests a token other than SBC.

`--faucet-url <url>`, `RADIUS_FAUCET_URL` or `faucetUrl` in `~/.radius/config.json` point at another faucet (a same-origin proxy, a local instance). Faucet errors are printed to stderr as `faucet: <code> …` with the faucet's `request_id`; exit code 2 means the faucet declined for now (`rate_limited` with the wait, `faucet_empty`, a signature we cannot provide), 1 anything else.

## x402 HTTP payments

Make an HTTP request and, if the server responds with `402 Payment Required` and an [x402](https://x402.org) challenge, pay it from the local wallet and retry. The protocol side is handled by [`radius-sdk`](../sdk) (`createRadiusFetch`), the same code applications and agents use; the CLI adds the wallet, prompts and output.

```bash
radius-cli wallet x402 get https://example.com/protected
radius-cli wallet x402 post https://api.example.com/x -d '{"a":1}' -H 'Authorization: Bearer …'
radius-cli wallet x402 get https://example.com/r --x402-threshold 0.05    # auto-pay up to 0.05 of the asset
radius-cli wallet x402 get https://example.com/r -y                       # auto-pay any amount
radius-cli wallet x402 get https://example.com/r --json                   # envelope with status/headers/body/payment
```

Verbs: `get`, `post`, `put`, `patch`, `delete`, `head`, `options`.

`-d, --data` accepts a literal string, `-d @path` to read from a file, or `-d -` to read from stdin. JSON-shaped bodies default to `Content-Type: application/json` unless one is set with `-H`.

`--x402-threshold <decimal>` is in the asset's display units (e.g. `0.05` means 0.05 SBC, which is $0.05 since SBC is USD-pegged). When the offered fee is at or below the threshold, the request pays without prompting — designed for AI agents and other non-interactive use. For the `upto` scheme the threshold is compared against the authorized maximum. Above the threshold the CLI prompts on a TTY and refuses (exit 2) without one; with `--yes` as well it refuses rather than pays, so the threshold stays a hard cap and `--yes` only means "don't ask". With no threshold, `--yes` pays any amount, and with neither flag a non-TTY run refuses (exit 2) rather than hang.

Payments are made on the configured network (`--network`) in SBC; offers on other networks or in other assets are refused before anything is signed, and the keystore is only unlocked once an offer has been accepted. `--sbc` / `RADIUS_SBC_ADDRESS` relocate the SBC contract (for another deployment of the same token); the CLI still assumes SBC's symbol, 6 decimals and EIP-712 domain behind that address. When a server lists several compatible offers the first one in its order is taken. Both x402 v1 and v2 are supported, selected automatically from the server's advertised `x402Version`:

- **`exact`** — a fixed price. v1 and v2 support EIP-3009 `transferWithAuthorization`; v2 also supports any ERC-20 advertised with `assetTransferMethod: "permit2"`, signing a Uniswap Permit2 `permitWitnessTransferFrom` authorization through `x402ExactPermit2Proxy`.
- **`upto`** (v2, Uniswap Permit2 `permitWitnessTransferFrom` via the `x402UptoPermit2Proxy`) — the client signs a Permit2 authorization up to a maximum and the facilitator settles the actual usage (which may be less, or zero).

Permit2 payments need an ERC-20 approval for the canonical Permit2 contract. When the server declares `eip2612GasSponsoring` (the Radius facilitator does), the CLI signs an EIP-2612 permit alongside the payment and no on-chain approval transaction is ever sent — a wallet holding only SBC can pay. Otherwise pass `--x402-approve-permit2` (or `-y`) to submit a one-time unlimited approval automatically; without it the CLI prompts (or refuses with no TTY). `--x402-approve-permit2` grants the approval whenever the allowance is short, sponsored or not, which is the way out when a facilitator answers 412. Each payment is still individually authorized by a signed Permit2 message capped to that payment's amount.

The paid retry is never replayed across a cross-origin redirect.

Body goes to stdout; payment confirmation and (optionally, with `--include`) headers go to stderr — pipeable.

## Read commands

```bash
radius-cli call 0xToken "balanceOf(address)(uint256)" 0xUser   # decoded result
radius-cli tx 0xTransactionHash
radius-cli receipt 0xTransactionHash
radius-cli storage 0xContract 0
radius-cli code 0xContract
radius-cli nonce 0xAddress
```

Function signatures use `cast` syntax: `name(args)` for state-changing calls, `name(args)(returns)` for read calls (the result is decoded against the return types).

## JSON output

Pass `--json` to any command to emit machine-readable JSON on stdout (one object per command, pretty-printed). Useful for piping into `jq` or driving the CLI from scripts and agents. Bigints are serialized as decimal strings.

```bash
$ radius-cli --json wallet address
{
  "address": "0x4F2D8a3b1c0E5d9b8e7a6c5d4e3f2a1b0c9d8e7f"
}

$ radius-cli --json wallet balance 0x4F2D8a3b1c0E5d9b8e7a6c5d4e3f2a1b0c9d8e7f
{
  "address": "0x4F2D8a3b1c0E5d9b8e7a6c5d4e3f2a1b0c9d8e7f",
  "totalUsd": 12.345678,
  "sbc": "10.000000",
  "rusd": "2.345678",
  "sbcWei": "10000000",
  "rusdWei": "2345678000000000000",
  "sbcError": null
}

$ radius-cli --json wallet send 0xRecipient 0.10 RUSD | jq -r .hash
0xabc…

$ radius-cli --json call 0xToken "balanceOf(address)(uint256)" 0xUser
"42000000"

$ radius-cli --json nonce 0xAddress
{
  "address": "0xAddress",
  "nonce": 17
}
```

Per-command JSON shapes:

| Command | JSON shape |
|---|---|
| `wallet new` / `wallet import` | `{path, address}` |
| `wallet address` | `{address}` |
| `wallet export` | `{address, privateKey}` |
| `wallet sign` | `{address, signature}` |
| `wallet verify` | `{address, valid}` (exit 1 when invalid) |
| `wallet balance` | `{address, totalUsd, sbc, rusd, sbcWei, rusdWei, sbcError}` |
| `wallet send` | `{hash, receipt?}` (no `receipt` with `--no-wait`) |
| `wallet x402` | `{status, headers, body, bodyEncoding, payment}` |
| `wallet faucet` / `wallet faucet drip` | `{faucetUrl, address, token, amount, txHash, explorerUrl, native, nextDripAt}` |
| `wallet faucet status` | `{faucetUrl, address, token, rateLimited, retryAfterMs, remainingRequests, dripAmount, nativeDripAmount, unlimited}` |
| `call` | decoded return value (single value or array) |
| `tx` | the full transaction object |
| `receipt` | the full receipt object |
| `code` | `{address, code}` |
| `nonce` | `{address, nonce}` |
| `storage` | `{address, slot, value}` |

Errors continue to go to stderr as `error: <message>` with a non-zero exit code; only successful output is JSON-shaped.

## Configuration

In priority order (highest first):

1. **CLI flag** — `--network`, `--rpc-url`, `--private-key`, `--sbc`, `--rusd`, `--json`
2. **Environment** — `RADIUS_NETWORK`, `RADIUS_RPC_URL`, `RADIUS_SBC_ADDRESS`, `RADIUS_RUSD_ADDRESS`, `RADIUS_FAUCET_URL`, `RADIUS_PASSWORD`, `RADIUS_KEYSTORE_PATH`, `RADIUS_HOME`
3. **`~/.radius/config.json`** — fields: `network`, `rpcUrl`, `sbcAddress`, `rusdAddress`, `faucetUrl`
4. **Built-in defaults** — mainnet

The SBC contract address must be configured for `wallet balance` and `wallet send … SBC` to work — there is no public default.

## Notes on the Radius network

- **RUSD** is the native gas token (18 decimals). `wallet send … RUSD` is a native value transfer.
- **SBC** is an ERC-20 stablecoin (6 decimals). `wallet send … SBC` calls `transfer(address,uint256)` on the SBC contract.
- Radius uses **fixed gas pricing**. All transactions will execute with the network gas price (n.b. they will fail if the requested gas price is too low).
- If the account holds SBC but lacks RUSD, the network's Turnstile auto-converts SBC to RUSD inline for zero additional gas.

## Development

This package lives in the `packages/cli` workspace of the radius-cli repository, next to `packages/sdk`.

```bash
pnpm install                     # at the repository root
pnpm --filter radius-cli build   # tsc -b: builds packages/sdk first when its dist is missing or stale
pnpm --filter radius-cli test
node packages/cli/dist/index.js --help
```
