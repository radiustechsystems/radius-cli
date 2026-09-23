# radius

Tools for the [Radius Network](https://radiustech.xyz), managed as one pnpm workspace.

| Package | What |
| --- | --- |
| [`packages/cli`](./packages/cli) | `radius-cli` — CLI wallet for Radius, modeled on Foundry's `cast` |
| [`packages/sdk`](./packages/sdk) | `radius-sdk` — accept and make Radius payments over x402 v2 (Hono / Cloudflare Workers first) |

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

1. Merging PRs that carry changesets to `main` opens or refreshes a **Version Packages** PR (branch `changeset-release/main`). It applies the pending changesets: version bumps and `CHANGELOG.md` entries, with `radius-cli` bumped whenever `radius-sdk` moves, since its `workspace:^` range pins the exact 0.0.x version. Review it like any other PR; it keeps updating as more changesets land.
2. Merging the Version Packages PR builds, tests and packs the bumped packages, publishes them to npm in dependency order (SDK before CLI), pushes a `<name>@<version>` git tag for each, and creates a GitHub Release from the changelog.

Publishing uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers): the `publish` job authenticates with a short-lived GitHub OIDC token, no `NPM_TOKEN` secret exists, and npm attaches provenance attestations automatically. Only that job has `id-token: write`.

One-time setup (repeat the npm step for every new package):

- On npmjs.com, for `radius-cli` and `radius-sdk`: **Settings → Trusted Publisher → GitHub Actions**, organization `radiustechsystems`, repository `radius-cli`, workflow filename `release.yml`, environment blank (or `npm` if you enable the `environment:` line in the publish job). Once a trusted publish succeeds, set **Publishing access** to *Require two-factor authentication and disallow tokens* so tokens can no longer publish.
- On GitHub, **Settings → Actions → General → Workflow permissions**: tick *Allow GitHub Actions to create and approve pull requests* (needed to open the Version Packages PR) and choose *Read repository contents and packages permissions* (every workflow declares the permissions it needs). If the option is greyed out, enable it for the organization first.
- Optional: mark the `changeset`, `Node 20` and `Node 24` checks as required in the `main` branch ruleset.

Manual fallback: `pnpm version-packages`, merge, then `pnpm release` publishes with `changeset publish`. Each package can also publish from its own directory (`pnpm publish` inside `packages/<name>`); the CLI's `prepublishOnly` refuses to publish until the SDK version it depends on is on npm. Note that `pnpm pack`/tarball publishing in CI does not run `prepublishOnly`, which is why the release workflow builds explicitly and relies on changesets' dependency ordering instead.
