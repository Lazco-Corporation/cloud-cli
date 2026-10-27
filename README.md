<div align="center">

# lazco

Lazco Cloud CLI and local MCP server: manage your Lazco Cloud resources from a terminal, a script or an AI agent.

[![npm](https://img.shields.io/npm/v/@lazco/cli)](https://www.npmjs.com/package/@lazco/cli) [![CI](https://github.com/Lazco-Corporation/cloud-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Lazco-Corporation/cloud-cli/actions/workflows/ci.yml) [![Node.js](https://img.shields.io/node/v/@lazco/cli)](package.json) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Installation](#installation) · [Quick start](#quick-start) · [Sign in](#sign-in) · [Scripts](#use-it-in-a-script) · [Spending](#commands-that-spend) · [MCP](#use-it-from-an-mcp-client)

</div>

`lazco` is the command line of [Lazco Cloud](https://lazco.tw).
It runs the operations of the Lazco Cloud API, such as servers, DNS, domains, billing, Lazco Pages and Lazco Artifacts.

## Highlights

- **Every API operation is a command.**
  `lazco` reads the API's spec when it runs, so a new API operation is a command on the day the API ships it, with no update of `lazco`.
- **Answers in JSON.**
  stdout holds only the answer, and an error is one JSON line on stderr with exit code 1.
  See [Use it in a script](#use-it-in-a-script).
- **No charge without a quote.**
  A command that spends from your account balance shows the price from the API first, and asks you.
  A retry never charges twice.
  See [Commands that spend](#commands-that-spend).
- **Credentials in the OS keychain.**
  Sign in in a browser, with a code on another device, or with an API token.
  See [Sign in](#sign-in).
- **An MCP server for 8 AI clients.**
  `lazco mcp install` adds it to Claude Code, Codex, Cursor and 5 more, with read tools only until you allow writes.
  See [Use it from an MCP client](#use-it-from-an-mcp-client).
- **Publish a site or a document.**
  Deploy a directory to Lazco Pages and upload only the changed files, or publish an HTML or Markdown file as a Lazco Artifact.
  See [Publish a Lazco Pages site](#publish-a-lazco-pages-site).

## Installation

With Node.js 22 or later, install `lazco` from npm:

```sh
npm install -g @lazco/cli
```

Check the install:

```sh
lazco --version
```

It prints the version, such as `0.2.0`.

To run `lazco` without an install, use `npx -y @lazco/cli <command>`.

To install the binary, which needs no Node.js, on macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Lazco-Corporation/cloud-cli/main/scripts/install.sh \
  | bash -s -- install
```

The installer puts `lazco` in `~/.local/bin`, or in `$LAZCO_INSTALL_DIR`, and checks the archive against `SHA256SUMS`.
Run it again with `update` or `uninstall` in place of `install`.
When GitHub limits the API rate of your network, the installer fails.
Set `GH_TOKEN` to a GitHub token and run it again.

On Windows, use npm, or download the zip from a [release](https://github.com/Lazco-Corporation/cloud-cli/releases).
Each release has archives for darwin-arm64, darwin-x64, linux-x64, linux-arm64 and windows-x64.

## Quick start

| Use | How | You get |
|---|---|---|
| In a terminal | Add `--human` to a command | A table or a list of fields |
| In a script | Run the command as it is | JSON on stdout, errors as JSON on stderr |
| From an AI agent | `lazco mcp install --client <client>` | The API operations as MCP tools |

1. Sign in.
   On a terminal, `lazco` asks which way to sign in:

   ```sh
   lazco auth login
   ```

2. Check who you are signed in as:

   ```sh
   lazco whoami --fields organization,role
   ```

   ```json
   {"organization":{"id":"<organization id>","name":"<organization name>"},"role":"owner"}
   ```

3. List your servers as a table:

   ```sh
   lazco compute list --human
   ```

Find the command you need:

| Command | Prints |
|---|---|
| `lazco --help` | The command groups, such as `compute`, `dns` and `billing` |
| `lazco compute --help` | The commands of one group |
| `lazco compute create --help` | The arguments and the flags of one command |
| `lazco --describe` | Every command, one JSON line each |
| `lazco --describe compute create` | One command and its input as JSON Schema |

## Sign in

| Command | Signs in with |
|---|---|
| `lazco auth login --sso` | Your Lazco account, in a browser on this machine |
| `lazco auth login --device` | Your Lazco account, with a URL and a code that you open on another device |
| `lazco auth login --with-token` | An API token from stdin, which you create on the API page of the Lazco Cloud panel |

In a script, pipe the token in:

```sh
printf '%s' "$TOKEN" | lazco auth login --with-token
```

With `--sso`, your browser opens the Lazco Cloud sign-in.
Pick the organization and the access, read only or read and write, then go back to the terminal.
Over SSH, or on Linux with no display, `--sso` prints a URL and a code, the same as `--device`.
Enter the code only on the page that the URL opens.

| Flag | Does |
|---|---|
| `--org <organization id>` | Preselects that organization |
| `--read-only` | Asks for read-only access |
| `--switch` | Picks the organization again, and signs out the previous sign-in of the profile |

An SSO sign-in renews itself while you use it, and ends after 30 days without use.
You can see and end it in the signed-in products of the Cloud panel's settings.

`lazco` stores the credential in the OS keychain.
When there is no keychain, it stores the credential in its config file with mode 0600, and says so on stderr.

| Command | Does |
|---|---|
| `lazco auth status` | Prints the profile, the method, the organization, the role, the access and the expiry |
| `lazco auth logout` | Signs out and forgets the credential. An API token stays valid until you revoke it in the panel |
| `lazco profile list` | Prints one line per profile, never its credential |
| `lazco profile use <name>` | Makes a profile the current one |

A profile is one stored sign-in, for example one for each organization.
Add `--profile <name>` to any command to sign in to or use another profile.
Without it, `lazco` uses the current profile, which starts as `default`.

## Use it in a script

- stdout holds only the answer: one JSON object, or one JSON object per line for a list with pages.
- An error is one line `{"error":{"code":"...","message":"..."}}` on stderr, and the exit code is 1.
  A code that starts with `CLI_` comes from `lazco`.
  Any other code comes from the API.
- Every other line on stderr starts with `lazco: `, such as a warning or the progress of a task.
- A command that starts a task, such as a deploy, waits until the task ends.

| Flag | Does |
|---|---|
| `--json <payload>` | Gives the whole input as JSON. `--json -` reads it from stdin |
| `--fields <a,b>` | Keeps only these top-level fields of each record |
| `--page-all` | Follows every page of a list |
| `--dry-run` | Checks the input and prints the request, and sends nothing |
| `--yes` | Confirms a command that deletes or spends, with no question |
| `--no-wait` | Prints the accepted task at once, and does not wait for it |
| `--timeout <seconds>` | Sets how long to wait for a task. The default is 600 |
| `--human` | Prints readable text instead of JSON |

| Environment variable | Does |
|---|---|
| `LAZCO_TOKEN` | Uses this API token, and ignores every profile |
| `LAZCO_PROFILE` | Picks the profile |
| `NO_COLOR` | Turns off the color of `--human` |

For example, check a new server's input before you send it:

```sh
lazco compute create --json - --dry-run < server.json
```

A command that deletes asks first on a terminal.
Some delete commands also need a confirm field, such as `--confirm` of `lazco compute delete`, and `--yes` does not replace it.

## Commands that spend

A command that spends from your account balance, such as `lazco compute create`, follows these steps:

1. It asks the API for a quote, which charges nothing.
2. It shows the quote on stderr: the amount, each line, the period, the recurring charge and when the quote expires.
3. It asks you, or needs `--yes`.
   Without a yes, it exits with `CLI_CONFIRM_REQUIRED`, and `details.quote` of the error holds the quote.
4. It spends exactly the quoted amount.

`--dry-run` gets the quote and prints the request that it would send, with the quote in `quote`.
To spend with a quote that you already have, add `--quote-id <id>` and `--expected-amount <amount>`.
A quote is good for 10 minutes and for one spend.
When the API refuses a quote, `lazco` does not get a new one by itself, because nobody saw that price.

Each spend sends an idempotency key, so a retry after a lost answer never charges twice.
To pick the key, add `--idempotency-key <key>`.
Run the same command with the same key within 24 hours to get the first result, not a second charge.

## Publish a Lazco Pages site

```sh
lazco labs pages deployments create <site-id> ./dist
```

The directory becomes the root of the site, and every file in it becomes public.
`lazco` skips each path with a segment that starts with a dot, `__MACOSX` or `node_modules`, so a `.env` next to your build is never published.
It refuses a link, a zip archive or a single file.
Unpack an archive first.

The command checks the limits of the API before it sends anything.
It uploads only the files that changed since the live deploy, and waits until the new deploy is live.
A failed or stopped upload cancels the deploy, so the next deploy can start at once.
Add `--dry-run` to print the file list that it would send.

## Publish a Lazco Artifact

A Lazco Artifact is a document or a web page with a permanent link.

```sh
lazco labs artifacts publish ./report.md --region <region> --title "<title>"
lazco labs artifacts update <artifact-id> ./report.md
```

The path is one HTML or Markdown file, or a directory with one entry file and the images, CSS and fonts that it uses.
Anyone with the link in `url` of the answer can open it.
In a directory, `lazco` skips each file or directory whose name starts with a dot.

`lazco` refuses a file type that an artifact cannot hold, more than 100 files, or more than 5 MiB, before it sends anything.
`warnings` in the answer lists what the page loads from outside, misses or runs, because those parts will not work.

An update fails when someone changed the artifact after `lazco` read it, so it never overwrites that change.
`lazco labs artifacts delete <artifact-id>` stops the link at once.

## Use it from an MCP client

`lazco mcp` is a local MCP server that uses the same sign-in as the commands.
Add it to your client:

```sh
lazco mcp install --client <client>
```

`<client>` is one of `claude-code`, `claude-desktop`, `codex`, `cursor`, `devin`, `gemini`, `pi` or `vscode`.
Add `--dry-run` to see the entry without writing it.
The entry holds the command only, never a credential.

| Flag | The server offers |
|---|---|
| None | Read tools only |
| `--allow-writes` | Also the tools that change things, and the delete tools that need the resource's name |
| `--allow-spend` | With `--allow-writes`, also the tools that spend from the account balance, each with its quote tool |

A spend tool needs a quote from its quote tool.
Its description tells the model to show you the quote and get your yes first.
When the client can ask you itself (MCP elicitation), the server shows you the quote and spends only after you accept.
A read-only sign-in gets read tools only.
`--profile <name>` picks the profile that the server uses.

To offer the tools of some products only, add `--only` with the first words of their commands.
Repeat it for each product.
For example, for Lazco Artifacts and Lazco Pages only:

```sh
lazco mcp install --client <client> --allow-writes --only "labs artifacts" --only "labs pages"
```

Run `lazco <prefix> --help`, such as `lazco labs artifacts --help`, to see the commands a prefix keeps.
The server does not start when a prefix matches no command with an MCP tool.
Some commands have no MCP tool, so a prefix that `--help` shows can still match no tool.
`--only` only shortens the tool list that the server offers.
It does not limit what your sign-in can do.

For a desktop client, install `lazco` globally first, so the entry names its full path.

## Limitations

- **Commands follow your organization.**
  `--help` and `--describe` hide the commands of a product that your organization has not turned on.
- **It needs the API to start.**
  `lazco` reads the spec from the API and keeps a copy for 10 minutes.
  With no network and no copy, the API commands do not run.
- **`--human` is for people.**
  Its columns follow the API's answer.
  Parse the JSON in a script.

## Contributing

Report a bug or ask for a feature in [GitHub issues](https://github.com/Lazco-Corporation/cloud-cli/issues).
For a question about your account or a bill, write to `support@lazco.tw`.
Report a vulnerability to `security@lazco.tw`, not in an issue.

The changes of each release are in [CHANGELOG.md](CHANGELOG.md).
The build and test commands are in [AGENTS.md](AGENTS.md), and [docs/](docs/) explains how the code works.

## License

[MIT](LICENSE).
Each binary carries the notices of the code compiled into it in `THIRD_PARTY_NOTICES.txt`.
