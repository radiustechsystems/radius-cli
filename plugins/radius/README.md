# Radius development plugin

The `radius-dev` Claude Code plugin provides three skills:

- `radius-dev` for Radius Network application development
- `x402` for Radius payment integrations
- `dripping-faucet` for testnet faucet workflows

The SDK examples target `radius-sdk` 0.3.0 or later, and terminal wallet
examples target `radius-cli` 0.4.0 or later (`wallet pay`). Install the peer dependency
needed by the SDK entry point you use (`viem` for `/client`, `hono` for `/hono`).

Install it from the [Radius CLI repository](https://github.com/radiustechsystems/radius-cli):

```sh
claude plugin marketplace add radiustechsystems/radius-cli
claude plugin install radius-dev@radius-cli
```

After a new plugin version is published, update an existing installation with
`claude plugin update radius-dev@radius-cli`. Automatic updates depend on the
user's marketplace setting.

The plugin is versioned independently from the `radius-cli` and `radius-sdk`
npm packages. Its version is in `.claude-plugin/plugin.json`; the GitHub
marketplace lists the plugin at `.claude-plugin/marketplace.json` in the
repository root. See the [repository release instructions](https://github.com/radiustechsystems/radius-cli#agent-skills)
for validation and compatibility rules.

This plugin is distributed under the repository's [MIT license](https://github.com/radiustechsystems/radius-cli/blob/main/LICENSE).
