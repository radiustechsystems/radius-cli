# radius

Tools for the [Radius Network](https://radiustech.xyz), managed as one pnpm workspace.

| Package | What |
| --- | --- |
| [`packages/cli`](./packages/cli) | [`radius-cli`](https://www.npmjs.com/package/radius-cli) — CLI wallet for Radius, modeled on Foundry's `cast`; `wallet pay` pays x402 on Radius (and optionally Base) through `radius-sdk` |
| [`packages/sdk`](./packages/sdk) | [`radius-sdk`](https://www.npmjs.com/package/radius-sdk) — accept and make x402 v2 payments on Radius (and optionally Base or any EVM chain) from any web-standard runtime, Hono, or the upstream x402 framework adapters (Express, Next.js), plus balance and settlement helpers |

```bash
npx radius-cli wallet balance     # the CLI
pnpm add radius-sdk               # SDK, seller side (add hono, or @x402/express + express, for those stacks)
pnpm add radius-sdk viem          # SDK, buyer / agent side
```

Runnable SDK examples (seller workers with and without Hono, an Express seller, agent buyer, browser demo dapp) are in [`packages/sdk/examples`](./packages/sdk/examples).

## Agent skills

The [Radius Claude Code plugin](plugins/radius) contains the `radius-dev`, `x402`,
and `dripping-faucet` skills. The marketplace manifest is at
[`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json). These files
live outside `packages/*`. The plugin has its own version in
[`plugins/radius/.claude-plugin/plugin.json`](plugins/radius/.claude-plugin/plugin.json)
and does not enter the npm Changesets release flow. The marketplace's
`metadata.version` describes the catalog, not the plugin; the marketplace entry
does not duplicate the plugin version.

In Claude Code, install from this repository:

```text
/plugin marketplace add radiustechsystems/radius-cli
/plugin install radius-dev@radius-cli
```

Update an installed plugin with `claude plugin update radius-dev@radius-cli`.
For every release-worthy change under `plugins/radius/skills`, or to the plugin
manifest or README, bump the plugin manifest version in the same PR: patch for
corrections, minor for new capabilities, major for incompatible changes. The
plugin CI check enforces a version increase independently of Changesets.
After merging to `main`, users of this GitHub marketplace can update; marketplace
automatic updates are off by default unless users enable them. A plugin release
may be tagged `radius-dev--v<version>` for a traceable release point.

When CLI or SDK work changes a documented API, audit the affected skills in
the package PR. Publish plugin instructions for a new package API only after
the corresponding npm version is available, and state the minimum package
version in that guidance. This avoids directing installed plugin users to code
that has merged but has not yet been published to npm.

For skill changes, run `python3 scripts/validate_plugin.py`,
`claude plugin validate plugins/radius --strict`, and
`claude plugin validate . --strict`. The path-filtered
[`plugin-evals.yml`](.github/workflows/plugin-evals.yml) runs Claude Code plugin
evals on trusted plugin changes. Add or update cases under
[`plugins/radius/evals`](plugins/radius/evals) with each behavior change, inspect
the CI report, then revise the skill or case based on the observed result.
The existing skill `evaluations/*.json` files remain as scenario references;
Claude Code uses the `evals/` suite for executable checks.

CI accepts either an `ANTHROPIC_API_KEY` secret, or an `OPENROUTER_API_KEY`
secret with repository variable `CLAUDE_EVAL_PROVIDER=openrouter`. Set
`CLAUDE_EVAL_MODEL` and `CLAUDE_EVAL_JUDGE_MODEL` repository variables to model
IDs supported by the chosen provider. The defaults target Anthropic. Fork PRs
run static checks without model credentials; trusted PRs and main pushes run
the paid eval suite. No eval case is allowed to execute wallet or payment tools.

The older skills repository still owns its live Hermes subscriber publisher.
Moving that publisher requires updating subscribers' repository and commit
settings first; this plugin migration does not send those webhooks.

## Development

```bash
pnpm install                          # installs every workspace package
pnpm build                            # builds every package
pnpm test                             # runs every package's tests
pnpm --filter radius-cli build        # one package
node packages/cli/dist/index.js --help
```

Requires Node ≥ 20 and pnpm 10 (`corepack enable pnpm`). `pnpm build` / `pnpm test` / `pnpm typecheck` at the root run every package in dependency order. Building or typechecking the CLI on its own also works from a fresh clone: `packages/cli` is a TypeScript project reference to `packages/sdk`, so `tsc -b` rebuilds the SDK whenever its source is newer than its `dist`; the CLI's tests read the SDK from source.

Every PR that changes `packages/cli` or `packages/sdk` adds a [changeset](.changeset/README.md) (`pnpm changeset`); the `changeset` GitHub check enforces it, and a bot comment on the PR lists what will be released. CI (`.github/workflows/ci.yml`) builds, typechecks and tests every package on Node 20 and 24.

## Releasing

Releases are automated with [changesets/action](https://github.com/changesets/action) (`.github/workflows/release.yml`):

1. Merging PRs that carry changesets to `main` opens or refreshes a **Version Packages** PR (branch `changeset-release/main`). It applies the pending changesets: version bumps and `CHANGELOG.md` entries, with `radius-cli` given at least a patch bump whenever `radius-sdk` moves (`updateInternalDependencies: "patch"`), so every SDK release ships a CLI built against it. Review it like any other PR; it keeps updating as more changesets land.
2. Merging the Version Packages PR builds, tests and packs the bumped packages, publishes them to npm in dependency order (SDK before CLI), pushes a `<name>@<version>` git tag for each, and creates a GitHub Release from the changelog.

Publishing uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers): the `publish` job authenticates with a short-lived GitHub OIDC token, no `NPM_TOKEN` secret exists, and npm attaches provenance attestations automatically. Only that job has `id-token: write`.

One-time setup (repeat the npm step for every new package):

- On npmjs.com, for `radius-cli` and `radius-sdk`: **Settings → Trusted Publisher → GitHub Actions**, organization `radiustechsystems`, repository `radius-cli`, workflow filename `release.yml`, environment blank (or `npm` if you enable the `environment:` line in the publish job). Once a trusted publish succeeds, set **Publishing access** to *Require two-factor authentication and disallow tokens* so tokens can no longer publish.
- On GitHub, **Settings → Actions → General → Workflow permissions**: tick *Allow GitHub Actions to create and approve pull requests* (needed to open the Version Packages PR) and choose *Read repository contents and packages permissions* (every workflow declares the permissions it needs). If the option is greyed out, enable it for the organization first.
- Optional: mark the `changeset`, `Node 20` and `Node 24` checks as required in the `main` branch ruleset.

Manual fallback: `pnpm version-packages`, merge, then `pnpm release` publishes with `changeset publish`. Each package can also publish from its own directory (`pnpm publish` inside `packages/<name>`); the CLI's `prepublishOnly` refuses to publish until the SDK version it depends on is on npm. Note that `pnpm pack`/tarball publishing in CI does not run `prepublishOnly`, which is why the release workflow builds explicitly and relies on changesets' dependency ordering instead.
