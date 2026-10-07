# Run the agent payment evaluation

From the repository root, after `pnpm install --frozen-lockfile`:

```sh
pnpm eval:payments          # build, then run 20 local HTTP/CLI/SDK/policy cases
pnpm eval:payments:agent    # build, then run 6 proposal cases x 3 seeds x 2 phrasings
```

Both commands are unfunded and require no RPC or wallet credentials. The first starts loopback HTTP seller, redirect sink, and JSON-RPC fixtures; it runs the built CLI as a subprocess and the SDK buyer directly. It checks signed EIP-3009 and Permit2 authorizations, offer selection, threshold refusal, POST body replay, redirect handling, missing receipts, paid errors, and lost responses. A small file-backed policy fixture also checks concurrent budget reservation and restart/idempotency behavior. These checks do not constitute a production policy service. The fixture simulates settlement. `simulatedSettlement: true` never means a network payment occurred.

The second command tests **agent proposals** and host authorization. Its default adapter is [`reference-agent.mjs`](reference-agent.mjs), a deterministic policy baseline, not a language model. It receives task wording, page text, a parsed 402 offer, and policy as JSON on stdin; it returns one JSON object such as `{"decision":"buy","selectedUrl":"https://seller.eval.local/api/lookup"}` on stdout. Valid decisions are `buy`, `decline`, and `reconcile`. The host keeps the signer and refuses a wrong recipient, over-cap offer, exhausted budget, or unknown prior outcome. The adapter does not browse live pages, and `reconcile` is a proposal only. This run does not prove full autonomous discovery, durable budget enforcement, or network settlement.

The file-backed policy fixture is an evaluation oracle, not a deployable policy service. It serializes concurrent reservations and preserves an unknown/settled task across reopening the ledger, rejects a changed offer under one idempotency key, and blocks invalid state transitions. Its `simulatedVerified` marker is supplied by the test and does not check chain evidence. A killed-process recovery drill is not covered; abandoned lock directories are not recovered by this fixture.

Useful options after the build:

```sh
node evaluations/agent-payments/run.mjs --list
node evaluations/agent-payments/run.mjs --case SDK-UPTO
node evaluations/agent-payments/agent.mjs --case DISC-02 --seed 2
node evaluations/agent-payments/agent.mjs --agent-command node \
  --agent-arg /absolute/path/to/your-agent-adapter.mjs
```

An external adapter is a trusted local executable invoked without a shell. It receives no Radius signer environment variables. Only `PATH` is passed by default; use `--agent-env NAME` to pass a specific non-`RADIUS_` variable such as a model API key. Each invocation has a 30-second timeout and a 64 KB output limit. A malformed or failing adapter creates failed case records and a nonzero suite exit. Your adapter can use any model or agent framework as long as it follows the JSON stdin/stdout protocol. The input includes `scenarioId`, `seed`, `task`, `page`, `url`, `offer`, `policy`, and `previousOutcome`.

Reports are written to the ignored `evaluations/agent-payments/results/` directory. Use `--output /path/report.json` to choose another location. Reports include case failures, per-axis scores, package commit, redacted HTTP traces, and explicit `verifiedNetworkSettlement: false` for local runs. The offline runner exits nonzero on any failed case.

## Funded testnet proof

The opt-in command pays a **0.001 SBC resource price** to a separate seller on Radius testnet; network fees may also apply. It uses an in-process SDK seller and buyer, the real facilitator, and an independent transaction receipt plus payment-asset transfer check. It refuses unsponsored Permit2 approval, so a facilitator without gas sponsorship can make the run fail before payment. Provide a testnet-only key through a secure environment source; the runner never prints it.

```sh
pnpm build
# Set RADIUS_EVAL_PRIVATE_KEY and RADIUS_EVAL_PAY_TO in the environment securely only for the next command.
RADIUS_EVAL_LIVE=1 pnpm eval:payments:live --confirm-testnet-spend
```

The command requires `RADIUS_EVAL_PAY_TO` to differ from the buyer address and cannot select mainnet. A paid failure writes a partial report containing any known transaction hash for reconciliation. A successful `live.json` report is the only runner output with `verifiedNetworkSettlement: true`. On 2026-10-07, `NET-01` passed once with a distinct recipient, delivered HTTP 200, and a matching 1,000-atomic-unit testnet transfer in transaction `0x334e08c9673c4da6760035e1130095039b279bda36a5456983be1cd7e9d7f6d2`.

The broader [framework and scenario catalog](../../docs/agent-payments-evaluation-framework.md) also proposes process-level concurrency, browser discovery, live unknown-outcome recovery, and seller delivery recovery. Those are not implemented by these commands yet.
