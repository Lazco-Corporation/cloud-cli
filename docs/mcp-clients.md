# MCP clients

`lazco mcp install --client <client>` adds or replaces one server entry named `lazco` in the user-level configuration of a client.
This file records where each client keeps that configuration, and the source each fact was checked against.
Check the sources again before you change a writer in `src/mcp/install.ts`, because clients move their files.

## The clients

Last checked on 2026-10-18.

| `--client` | Where the entry goes | Format | Source |
|---|---|---|---|
| `claude-code` | `claude mcp remove lazco --scope user`, then `claude mcp add-json lazco '<json>' --scope user`, stored in `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when set) | JSON with `type: "stdio"` | <https://docs.anthropic.com/en/docs/claude-code/mcp>, section "User scope", and `claude mcp add-json --help` |
| `claude-desktop` | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`, no Linux build | `mcpServers` | <https://modelcontextprotocol.io/quickstart/user> |
| `codex` | `codex mcp add lazco -- <command> <args>`, stored in `~/.codex/config.toml` (`$CODEX_HOME/config.toml` when set) | TOML `[mcp_servers.lazco]` | <https://developers.openai.com/codex/mcp>, and `codex mcp add --help` |
| `cursor` | `~/.cursor/mcp.json` | `mcpServers` | <https://cursor.com/docs/mcp>, section "Configuration locations" |
| `devin` | macOS and Linux `$XDG_CONFIG_HOME/devin/mcp_config.json` (`~/.config/devin/mcp_config.json` when unset), Windows `%APPDATA%\devin\mcp_config.json` | `mcpServers` | <https://docs.devin.ai/desktop/cascade/mcp>, section "mcp_config.json", and <https://docs.devin.ai/cli/reference/configuration/config-file> |
| `gemini` | `~/.gemini/settings.json` | `mcpServers` | <https://geminicli.com/docs/tools/mcp-server/> |
| `pi` | `~/.pi/agent/mcp.json` | `mcpServers` | `docs/mcp.md` of the `pi` package, section "Configure servers" |
| `vscode` | `$COPILOT_HOME/mcp-config.json` (`~/.copilot/mcp-config.json` when unset) | `mcpServers` | <https://code.visualstudio.com/docs/agent-customization/mcp-servers>, section "Configure the mcp.json file" |

`devin` is the client that was called Windsurf.
Devin Desktop replaced Windsurf in 2026 and moved the file from `~/.codeium/windsurf/`.

VS Code calls its user-profile `mcp.json` deprecated and points new servers to the Copilot file, which other Copilot tools read too.

## The entry

Every entry holds a command and its arguments, and nothing else.
It never holds a credential or an environment variable that holds one: the server reads the credential of its profile when the client starts it.

```json
{
  "mcpServers": {
    "lazco": { "command": "<absolute path>", "args": ["mcp", "--profile", "<profile name>", "--allow-writes"] }
  }
}
```

`--profile`, `--api-url`, `--allow-writes` and `--allow-spend` given to `install` go into `args`.
`--allow-spend` without `--allow-writes` is `CLI_INVALID_INPUT`, and nothing is written, because the server offers spend tools only with both.

The command is an absolute path, because a desktop client often starts with a `PATH` that lacks the user's shell setup.
It is chosen in this order:

1. The compiled binary that runs `install`.
2. A `lazco` on `PATH` that is not inside an `npx`, `bunx` or `pnpx` cache.
3. The runner that started `install`, read from `npm_config_user_agent`.
4. The first of `npx`, `bunx` and `pnpx` on `PATH`.

A runner gets `-y @lazco/cli mcp` for `npx`, and `@lazco/cli mcp` for `bunx` and `pnpx`.
While the version is 0.x the package is unpinned, and from 1.0 on it is pinned to its major version, such as `@lazco/cli@1`.

An `npx` entry still starts `node` through the client's `PATH`.
For a desktop client, install `lazco` globally first, with `scripts/install.sh` or `npm install -g @lazco/cli`, so that the entry names the binary.

## How a file is edited

The JSON writers use `jsonc-parser`, so the comments, the formatting and every other entry of the file stay as they were.
The new file is written to a temporary name and renamed over the old one.
When the file is a symlink, the link stays and its target gets the new content.
A file that is not a JSON object is left alone and the command fails with `CLI_INVALID_INPUT`.

`claude` and `codex` run through `cross-spawn`, so the `.cmd` file that an npm install makes on Windows runs with its arguments escaped for `cmd.exe`.

`claude-code` and `codex` are never edited directly.
Claude Code rewrites `~/.claude.json` while it runs, so a direct edit can be lost, and the Codex command keeps the comments of its TOML file.
When `claude` or `codex` is not on `PATH`, `install` fails with `CLI_INVALID_INPUT`.

## Clients left out

- Zed keeps its MCP entry inside the editor's whole settings file, and that schema changed between releases.
- Editor extensions keep their file in a path named after the extension's id.

Each one can be added later as one more case of `targetOf` in `src/mcp/install.ts`.
