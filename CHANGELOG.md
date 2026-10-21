# Changelog

All releases of `@lazco/cli` are in this file.
The newest release is at the top.

## [0.2.0]

### Added

- `lazco labs artifacts publish <path>` and `lazco labs artifacts update <artifact-id> <path>`, and the MCP tools `labs_artifacts_publish` and `labs_artifacts_update`, publish a Lazco Artifact from one HTML or Markdown file, or from a directory with one entry file and the images, CSS and fonts it uses.
  In a directory, every file or directory whose name starts with a dot is skipped, so a `.env` is never published.
  The command refuses a file type that an artifact may not hold, more than 100 files, and more than 5 MiB, before it sends anything.
  An update reads the current version first and sends it as `If-Match`, unless `--if-match` gives it, so a change made since then fails instead of being overwritten.

### Changed

- The browser page that ends an SSO sign-in uses the Lazco design, in the dark theme.

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
