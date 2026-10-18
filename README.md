# Lazco CLI

`lazco` is the command line and the local MCP server of [Lazco Cloud](https://lazco.tw).
Its commands come from the API itself, so every API operation is a command as soon as the API ships it.
Output is JSON by default, so scripts and agents can read it.

## Install

With Node.js 22 or later, run it without installing:

```sh
npx -y @lazco/cli --version
```

Or install it globally:

```sh
npm install -g @lazco/cli
```

Or install the binary, which needs no Node.js, on macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Lazco-Corporation/cloud-cli/main/scripts/install.sh | bash -s -- install
```

The installer puts `lazco` in `~/.local/bin`, or in `$LAZCO_INSTALL_DIR`, and checks the archive against `SHA256SUMS`.
Run it with `update` or `uninstall` later.
Each [release](https://github.com/Lazco-Corporation/cloud-cli/releases) also has the archives for darwin-arm64, darwin-x64, linux-x64, linux-arm64 and windows-x64.

## Sign in

Create an API token on the API page of the Lazco Cloud panel, then:

```sh
lazco auth login
```

It asks for the token without showing it, checks it, and stores it in the system keychain.
In a script, pipe the token in instead:

```sh
printf '%s' "$TOKEN" | lazco auth login --with-token
```

Login prints the profile, the API URL, the organization and where the token is stored:

```json
{"profile":"default","apiUrl":"https://api.lazco.tw/v1","organization":{"id":"<uuid>","name":"<name>"},"store":"keychain","current":true}
```

When there is no keychain, the token goes into the config file with mode 0600, `store` is `file`, and `path` names the file.

| Command | Prints |
|---|---|
| `lazco auth status` | `profile`, `apiUrl`, `store`, `organization`, `role`, `scope` and `expiresAt` |
| `lazco auth logout` | `{"profile":"<name>","loggedOut":true}`. The token stays valid until you revoke it in the panel, and stderr names the page |
| `lazco profile list` | One line per profile, never its token |
| `lazco profile use <name>` | Makes a profile the current one |

`--profile <name>` signs in or uses another profile, for example one organization each.
A profile name is 1 to 64 letters, digits, `.`, `_` or `-`, and starts with a letter or a digit.
Without `--profile`, the profile is `default`.
`LAZCO_TOKEN` overrides every profile, and `LAZCO_PROFILE` picks one.

## Use it

```sh
lazco compute list
lazco compute get <server-id>
lazco --describe compute create     # the command and its input as JSON Schema
lazco compute create --json - < server.json --dry-run
```

`lazco --help` lists the command groups, and `lazco --describe` lists every command.

- stdout holds the answer only: one JSON object, or one JSON object per line for a list.
- An error is one line `{"error":{"code":"...","message":"...",...}}` on stderr, and the exit code is 1. A code starting with `CLI_` comes from `lazco`, and any other code from the API.
- Every other line on stderr starts with `lazco: `, such as a warning or the flag that gets the next page.
- `--human` prints a table instead. `NO_COLOR` turns its color off.
- `--page-all` follows every page of a list.
- A command that deletes or spends asks first on a terminal. `--yes` confirms without asking, and a command that needs the resource's name still needs it in its field.
- A task such as a deploy is waited for. `--no-wait` prints the accepted task at once.

## Use it from an MCP client

`lazco mcp` is a local MCP server with the same sign-in.
Add it to a client with:

```sh
lazco mcp install --client <client>
```

`<client>` is one of `claude-code`, `claude-desktop`, `codex`, `cursor`, `devin`, `gemini`, `pi` or `vscode`.
The entry holds the command only, never the token.
`--profile <name>` and `--allow-writes` go into the entry, and `--dry-run` shows the entry without writing it.

Without `--allow-writes` the server offers read tools only.
With it, the server adds the tools that change things, and the deleting ones that need the resource's name.
It never offers a tool that spends money, and a read-only token gets read tools only.

For a desktop client, install `lazco` globally first, so the entry names it by its full path.

## License

MIT. The binaries carry the notices of the code compiled into them in `THIRD_PARTY_NOTICES.txt`.
