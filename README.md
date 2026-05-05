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
```

`--private-key 0xHEX` overrides the keystore on any command.

## x402 HTTP payments

Make an HTTP request and, if the server responds with `402 Payment Required` and an [x402](https://x402.org) challenge, pay it from the local wallet and retry.

```bash
radius-cli wallet x402 get https://example.com/protected
radius-cli wallet x402 post https://api.example.com/x -d '{"a":1}' -H 'Authorization: Bearer …'
radius-cli wallet x402 get https://example.com/r --x402-threshold 0.05    # auto-pay up to 0.05 of the asset
radius-cli wallet x402 get https://example.com/r -y                       # auto-pay any amount
radius-cli wallet x402 get https://example.com/r --json                   # envelope with status/headers/body/payment
```

Verbs: `get`, `post`, `put`, `patch`, `delete`, `head`, `options`.

`-d, --data` accepts a literal string, `-d @path` to read from a file, or `-d -` to read from stdin. JSON-shaped bodies default to `Content-Type: application/json` unless one is set with `-H`.

`--x402-threshold <decimal>` is in the asset's display units (e.g. `0.05` means 0.05 SBC, which is $0.05 since SBC is USD-pegged). When the offered fee is at or below the threshold, the request pays without prompting — designed for AI agents and other non-interactive use. With no threshold and no TTY, the command refuses (exit 2) rather than hang. The `exact` x402 scheme on EVM is supported (uses EIP-3009 `transferWithAuthorization`); the asset must implement it on the configured network.

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

## Configuration

In priority order (highest first):

1. **CLI flag** — `--network`, `--rpc-url`, `--private-key`, `--sbc`, `--rusd`, `--json`
2. **Environment** — `RADIUS_NETWORK`, `RADIUS_RPC_URL`, `RADIUS_SBC_ADDRESS`, `RADIUS_RUSD_ADDRESS`, `RADIUS_PASSWORD`, `RADIUS_KEYSTORE_PATH`, `RADIUS_HOME`
3. **`~/.radius/config.json`** — fields: `network`, `rpcUrl`, `sbcAddress`, `rusdAddress`
4. **Built-in defaults** — mainnet

The SBC contract address must be configured for `wallet balance` and `wallet send … SBC` to work — there is no public default.

## Notes on the Radius network

- **RUSD** is the native gas token (18 decimals). `wallet send … RUSD` is a native value transfer.
- **SBC** is an ERC-20 stablecoin (6 decimals). `wallet send … SBC` calls `transfer(address,uint256)` on the SBC contract.
- Radius uses **fixed gas pricing**. All transactions will execute with the network gas price (n.b. they will fail if the requested gas price is too low).
- If the account holds SBC but lacks RUSD, the network's Turnstile auto-converts SBC to RUSD inline for zero additional gas.

## Development

```bash
npm install
npm run build
npm test
node dist/index.js --help
```
