# Changesets

Every pull request that changes a publishable package (`packages/cli`, `packages/sdk`) adds a
changeset: `pnpm changeset`, pick the package(s), pick patch / minor / major, write the one-line
entry that will appear in the changelog. The `changeset` GitHub check refuses PRs that change a
package without one; add the `no changeset` label for changes that need no release note.

Releasing is automated by `.github/workflows/release.yml`. Merging changesets to `main` opens (or
refreshes) a **Version Packages** PR on the `changeset-release/main` branch: it runs `pnpm
version-packages` (bumps versions, writes CHANGELOG.md files, bumps `radius-cli` whenever `radius-sdk`
moves). Merging that PR publishes the bumped packages to npm through Trusted Publishing (no npm token),
pushes a `<name>@<version>` git tag for each, and creates a GitHub Release. The examples are private and
never versioned.

Manual fallback: `pnpm version-packages`, merge, then `pnpm release` (builds and runs `changeset publish`
in dependency order, SDK before CLI). See the root README for the one-time npm and GitHub setup.
