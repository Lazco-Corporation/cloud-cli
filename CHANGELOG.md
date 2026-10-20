# Changelog

All releases of `@lazco/cli` are in this file.
The newest release is at the top.

## [0.1.0]

### Added

- The `lazco` command, with every Lazco Cloud API operation as a command, read from the API's machine spec at run time.
- JSON on stdout, one error shape on stderr with fixed `CLI_` codes, and exit codes 0 and 1.
- `--describe`, `--dry-run`, `--fields`, `--page-all`, `--json`, `--yes`, `--wait`, `--timeout`, `--human`, `--profile` and `--api-url`.
- An `Idempotency-Key` on every request whose operation declares one, kept the same on every retry, so a retry after a lost answer never charges twice.
  Where the spec requires the header, `--idempotency-key <key>` chooses it, and a run with a generated key and no final answer names the key on stderr.
- A command that spends asks the API for a quote first, shows it on stderr, asks or needs `--yes`, and spends exactly the quoted amount from the account balance.
  `--dry-run` asks for the quote only, `--quote-id` with `--expected-amount` spends with a quote you already have, and a refused quote is never replaced by a new one.
- `lazco auth login` with your Lazco account in a browser (`--sso`), on this machine or with a code on another device (`--device`), or with an API token (`--with-token`), kept in the OS keychain, or in the config file with mode 0600 when there is no keychain.
- `lazco auth status`, and `lazco auth logout`, which revokes an SSO sign-in.
- An SSO sign-in refreshes its access token by itself, and two processes of one profile share one refresh.
- `lazco profile list` and `profile use`.
- `lazco labs pages deployments create <site> <directory>` and the MCP tool `labs_pages_create_deployment` publish a local directory to a Lazco Pages site, upload only the changed files, and wait until the site is live.
- `lazco mcp`, a local MCP server over stdio, and `lazco mcp install` for eight MCP clients.
- `lazco mcp --allow-writes --allow-spend` adds the tools that spend from the account balance, each with its quote tool, and asks the user through MCP elicitation when the client supports it.
- Binaries for macOS, Linux and Windows on the GitHub release, and `scripts/install.sh`.
