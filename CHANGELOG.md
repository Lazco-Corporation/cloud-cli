# Changelog

All releases of `@lazco/cli` are in this file.
The newest release is at the top.

## [0.1.0]

### Added

- The `lazco` command, with every Lazco Cloud API operation as a command, read from the API's machine spec at run time.
- JSON on stdout, one error shape on stderr with fixed `CLI_` codes, and exit codes 0 and 1.
- `--describe`, `--dry-run`, `--fields`, `--page-all`, `--json`, `--yes`, `--wait`, `--timeout`, `--human`, `--profile` and `--api-url`.
- `lazco auth login`, `auth status` and `auth logout` with an API token, kept in the OS keychain.
- `lazco profile list` and `profile use`.
- `lazco mcp`, a local MCP server over stdio, and `lazco mcp install` for eight MCP clients.
- Binaries for macOS, Linux and Windows on the GitHub release, and `scripts/install.sh`.
