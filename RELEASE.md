# Release Process

The release source of truth is the version in `package.json`. Every published
npm version should have a matching git tag and GitHub release.

`v0.1.4` is the baseline release for the already-published npm package. Future
releases should be created by bumping the package version and pushing the
matching `v*` tag.

## Stable Release

```bash
npm version 0.1.5
git push origin main --tags
```

Pushing the `v0.1.5` tag starts the release workflow. The workflow verifies that
the tag matches `package.json`, runs tests and build, publishes `radius-cli` to
npm with the `latest` dist-tag, ensures the npm dist-tag points at that version,
and creates the GitHub release.

## Alpha Release

```bash
npm version 0.2.0-alpha.0
git push origin main --tags
```

Pushing the `v0.2.0-alpha.0` tag starts the same workflow. Because the package
version is a prerelease, npm gets the `alpha` dist-tag and the GitHub release is
marked as a prerelease. The workflow also ensures `radius-cli@alpha` points at
that version.

Consumers can install the alpha explicitly:

```bash
npm install -g radius-cli@alpha
npx radius-cli@alpha --help
```

## Required Repository Setup

The workflow needs npm publish permission. Configure one of:

- npm trusted publishing for this repository and workflow, or
- an `NPM_TOKEN` repository secret with publish access to the `radius-cli`
  package.

Do not publish to npm manually without also creating the matching git tag,
GitHub release, and npm dist-tag.
