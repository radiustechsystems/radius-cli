# radius

A CLI wallet for the [Radius network](https://radiustech.xyz) — modeled on Foundry's `cast`, with a built-in account stored in `~/.radius/keystore.json`.

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

`radius-cli wallet new` generates a key, prompts for a password, and writes a Web3 Secret Storage v3 keystore at `~/.radius/keystore.json` (compatible with geth/foundry). The address is cached in `~/.radius/config.json` so `radius-cli wallet address` doesn't require the password.

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

## Notes on the network

- **RUSD** is the native gas token (18 decimals). `wallet send … RUSD` is a native value transfer.
- **SBC** is an ERC-20 stablecoin (6 decimals). `wallet send … SBC` calls `transfer(address,uint256)` on the SBC contract.
- Radius uses **fixed gas pricing**, not EIP-1559. All transactions are signed as legacy (type 0) with `gasPrice` from `eth_gasPrice`.
- If the account holds SBC but lacks RUSD, the network's Turnstile auto-converts SBC → RUSD inline at zero fee. No client-side handling required.

## Development

```bash
npm install
npm run build
npm test
node dist/index.js --help
```
