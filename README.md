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

Sign in with your Lazco account:

```sh
lazco auth login --sso
```

Your browser opens the Lazco Cloud sign-in. Pick the organization and the access, read only or read and write, and return to the terminal.
Over SSH, on Linux without a display, or with `--device`, `lazco` prints a URL and a code instead. Open the URL on any device and enter the code there, and only there.

| Option | Does |
|---|---|
| `--device` | Prints a URL and a code to sign in on another device, with no browser on this machine |
| `--org <organization id>` | Preselects that organization |
| `--read-only` | Asks for read-only access |
| `--switch` | Picks the organization again, and signs out the previous sign-in of the profile. When that sign-out fails, stderr says so, and the old sign-in stays in the list until you end it there |

The sign-in renews itself while you use it, and ends after 30 days without use.
You can see and end it in the signed-in products of the Cloud panel's settings.

Or sign in with an API token, which you create on the API page of the Lazco Cloud panel.
Without a flag, `lazco auth login` asks on a terminal which way to sign in, and asks for the token without showing it.
In a script, pipe the token in:

```sh
printf '%s' "$TOKEN" | lazco auth login --with-token
```

Login checks the credential and stores it in the system keychain.
It prints the profile, the method, the API URL, the organization, the access and where the credential is stored:

```json
{"profile":"default","method":"sso","apiUrl":"https://api.lazco.tw/v1","organization":{"id":"<uuid>","name":"<name>"},"scope":"read_write","store":"keychain","current":true}
```

When there is no keychain, the credential goes into the config file with mode 0600, `store` is `file`, and `path` names the file.

| Command | Prints |
|---|---|
| `lazco auth status` | `profile`, `method`, `apiUrl`, `store`, `organization`, `role`, `scope` and `expiresAt` |
| `lazco auth logout` | `{"profile":"<name>","loggedOut":true}`. It ends an SSO sign-in. When it cannot reach the API, it still forgets the profile, but exits with `CLI_NETWORK`, and the sign-in stays in the list until you end it there or it is unused for 30 days. An API token stays valid until you revoke it in the panel, and stderr names the page |
| `lazco profile list` | One line per profile, never its credential |
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
- A command that spends asks the API for a quote first, and shows it on stderr: the amount it takes from the account balance, each line, the period, the recurring charge, and when the quote expires.
  It then asks, or needs `--yes`, and spends exactly the quoted amount.
  Without a yes it exits 1 with `CLI_CONFIRM_REQUIRED`, and the error's `details.quote` holds the quote.
- `--dry-run` of a command that spends asks for its quote, which charges nothing, and prints the request it would send with the quote in `body` and in `quote`.
  `--quote-id <id>` with `--expected-amount <amount>` spends with a quote you already have, such as the one of a dry run, and asks for no new one.
  A quote is good for 10 minutes and for one spend. When the API refuses a quote, `lazco` never asks for a new one by itself, because that is a price nobody saw.
- A command that spends sends an `Idempotency-Key`, so a retry after a lost answer never charges twice.
  `--idempotency-key <key>` chooses the key: run the same command again with the same key, within 24 hours, to get the first result instead of a second charge.
- A task such as a deploy is waited for. `--no-wait` prints the accepted task at once.

### Publish a Lazco Pages site

```sh
lazco labs pages deployments create <site-id> ./dist
lazco labs pages deployments create <site-id> ./dist --dry-run
```

The directory is the site's root, and every file in it becomes public.
Paths with a segment that starts with a dot, `__MACOSX` and `node_modules` are skipped, so a `.env` next to a build is never published.
A link, a zip archive or a single file is refused: unpack an archive first.
The command checks the API's limits before it sends anything, uploads only the files that changed since the live deploy, and waits until the deployment is live, for 600 seconds or `--timeout`.
A failed or interrupted upload cancels the deployment, so the next deploy can start at once.
`--dry-run` reads the limits and the site, and prints the manifest it would send.

## Use it from an MCP client

`lazco mcp` is a local MCP server with the same sign-in, and it renews an SSO sign-in as it runs.
Add it to a client with:

```sh
lazco mcp install --client <client>
```

`<client>` is one of `claude-code`, `claude-desktop`, `codex`, `cursor`, `devin`, `gemini`, `pi` or `vscode`.
The entry holds the command only, never a credential.
`--profile <name>`, `--allow-writes` and `--allow-spend` go into the entry, and `--dry-run` shows the entry without writing it.

Without `--allow-writes` the server offers read tools only.
With it, the server adds the tools that change things, and the deleting ones that need the resource's name.
With `--allow-spend` too, it adds the tools that spend from the account balance, each with its quote tool.
A spend tool needs a quote from its quote tool, and its description tells the model to show the quote and get your yes first.
When the client can ask you itself (MCP elicitation), the server shows you the quote from the API and spends only after you accept.
A read-only token gets read tools only.

For a desktop client, install `lazco` globally first, so the entry names it by its full path.

## License

MIT. The binaries carry the notices of the code compiled into them in `THIRD_PARTY_NOTICES.txt`.
