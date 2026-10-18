import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import { applyEdits, modify, type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import { writeFileAtomic } from "../config/atomicFile";
import type { PathEnvironment } from "../config/paths";
import { CliError } from "../core/errors";

/** The server name every client gets. */
export const SERVER_NAME = "lazco";

export const MCP_CLIENTS = [
  "claude-code",
  "claude-desktop",
  "codex",
  "cursor",
  "devin",
  "gemini",
  "pi",
  "vscode",
] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

/** What a client starts: one executable and its arguments, never a credential. */
export type Launcher = { command: string; args: string[] };

/** Where an entry goes: a JSON file under one key, or the client's own command. */
type Target =
  | { kind: "file"; path: string; key: "mcpServers"; entry: Record<string, unknown> }
  | { kind: "command"; program: "claude" | "codex"; file: string };

/** The runners that can start the npm package, in the order tried. */
const RUNNERS = ["npx", "bunx", "pnpx"] as const;
type Runner = (typeof RUNNERS)[number];

/** A path inside a runner's cache, where a `lazco` found on `PATH` disappears later. */
const RUNNER_CACHE =
  /[\\/](_npx|\.bun[\\/]install[\\/]cache|bunx-[^\\/]*|dlx-[^\\/]*|\.pnpm-store)[\\/]/;

function invalid(message: string, field: string, fieldMessage: string): CliError {
  return new CliError("CLI_INVALID_INPUT", message, [{ field, message: fieldMessage }]);
}

/** The absolute path of an executable on `PATH`, with `PATHEXT` on Windows. */
export async function findOnPath(
  name: string,
  paths: PathEnvironment,
): Promise<string | undefined> {
  const directories = (paths.env.PATH ?? paths.env.Path ?? "").split(delimiter).filter(Boolean);
  const extensions =
    paths.platform === "win32"
      ? (paths.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        await access(candidate, paths.platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // Not here, so the next directory.
      }
    }
  }
  return undefined;
}

/** The runner that started this process, from `npm_config_user_agent`, such as `bun/1.2 ...`. */
function startingRunner(env: Record<string, string | undefined>): Runner | undefined {
  const agent = env.npm_config_user_agent?.split("/")[0];
  return agent === "npm" ? "npx" : agent === "bun" ? "bunx" : agent === "pnpm" ? "pnpx" : undefined;
}

/** `@lazco/cli` while the version is 0.x, and `@lazco/cli@<major>` from 1.0 on. */
export function packageSpec(version: string): string {
  const major = Number(version.split(".")[0]);
  return Number.isInteger(major) && major >= 1 ? `@lazco/cli@${major}` : "@lazco/cli";
}

/**
 * The command a client runs, as an absolute path, because a desktop client
 * often starts with a `PATH` that lacks the user's shell setup: a global
 * `lazco` when there is one, else the runner that started this process, else
 * the first of `npx`, `bunx` and `pnpx` found.
 */
export async function resolveLauncher(options: {
  paths: PathEnvironment;
  execPath: string;
  version: string;
  serverArgs: readonly string[];
}): Promise<Launcher> {
  const executable = basename(options.execPath).toLowerCase();
  if (executable === "lazco" || executable === "lazco.exe") {
    return { command: options.execPath, args: ["mcp", ...options.serverArgs] };
  }
  const global = await findOnPath("lazco", options.paths);
  if (global && !RUNNER_CACHE.test(global)) {
    return { command: global, args: ["mcp", ...options.serverArgs] };
  }
  const started = startingRunner(options.paths.env);
  const order = started ? [started, ...RUNNERS.filter((runner) => runner !== started)] : RUNNERS;
  for (const runner of order) {
    const path = await findOnPath(runner, options.paths);
    if (path) {
      const lead = runner === "npx" ? ["-y"] : [];
      return {
        command: path,
        args: [...lead, packageSpec(options.version), "mcp", ...options.serverArgs],
      };
    }
  }
  throw invalid(
    "No lazco, npx, bunx or pnpx was found on PATH: install lazco globally, or Node.js 22",
    "client",
    "needs lazco or a package runner on PATH",
  );
}

function home(paths: PathEnvironment, ...segments: string[]): string {
  return join(paths.home, ...segments);
}

function appData(paths: PathEnvironment): string {
  return paths.env.APPDATA || home(paths, "AppData", "Roaming");
}

/** Where each client keeps its user-level servers. `docs/mcp-clients.md` names the sources. */
function targetOf(client: McpClient, paths: PathEnvironment, launcher: Launcher): Target {
  const entry = { command: launcher.command, args: launcher.args };
  const file = (path: string): Target => ({ kind: "file", path, key: "mcpServers", entry });
  switch (client) {
    case "claude-code":
      return {
        kind: "command",
        program: "claude",
        file: join(paths.env.CLAUDE_CONFIG_DIR || paths.home, ".claude.json"),
      };
    case "codex":
      return {
        kind: "command",
        program: "codex",
        file: join(paths.env.CODEX_HOME || home(paths, ".codex"), "config.toml"),
      };
    case "claude-desktop":
      if (paths.platform === "darwin") {
        return file(
          home(paths, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        );
      }
      if (paths.platform === "win32") {
        return file(join(appData(paths), "Claude", "claude_desktop_config.json"));
      }
      throw invalid(
        "Claude Desktop has no build for this platform",
        "client",
        `claude-desktop runs on macOS and Windows only, not ${paths.platform}`,
      );
    case "cursor":
      return file(home(paths, ".cursor", "mcp.json"));
    case "devin":
      return file(
        paths.platform === "win32"
          ? join(appData(paths), "devin", "mcp_config.json")
          : join(paths.env.XDG_CONFIG_HOME || home(paths, ".config"), "devin", "mcp_config.json"),
      );
    case "gemini":
      return file(home(paths, ".gemini", "settings.json"));
    case "pi":
      return file(home(paths, ".pi", "agent", "mcp.json"));
    case "vscode":
      return file(join(paths.env.COPILOT_HOME || home(paths, ".copilot"), "mcp-config.json"));
  }
}

/** The text of a client file with the `lazco` entry added or replaced, comments and all. */
export function withEntry(
  text: string,
  path: string,
  key: string,
  entry: Record<string, unknown>,
): string {
  const source = text.trim() === "" ? "{}\n" : text;
  const errors: ParseError[] = [];
  const root = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || root === null || typeof root !== "object" || Array.isArray(root)) {
    const reason =
      errors.length > 0
        ? `${printParseErrorCode((errors[0] as ParseError).error)} at offset ${(errors[0] as ParseError).offset}`
        : "its top level is not an object";
    throw invalid(
      `${path} is not a JSON object (${reason}), so it is left as it is`,
      "client",
      reason,
    );
  }
  const container = (root as Record<string, unknown>)[key];
  if (container !== undefined && (container === null || typeof container !== "object")) {
    throw invalid(`${key} in ${path} is not an object, so it is left as it is`, "client", key);
  }
  const indentation = /\n([ \t]+)"/.exec(source)?.[1] ?? "  ";
  const edits = modify(source, [key, SERVER_NAME], entry, {
    formattingOptions: {
      insertSpaces: !indentation.startsWith("\t"),
      tabSize: indentation.startsWith("\t") ? 1 : indentation.length,
      eol: source.includes("\r\n") ? "\r\n" : "\n",
    },
  });
  return applyEdits(source, edits);
}

function run(program: string, args: readonly string[], env: Record<string, string | undefined>) {
  return new Promise<{ code: number; stderr: string }>((resolve) => {
    execFile(program, [...args], { env: env as NodeJS.ProcessEnv }, (error, _stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stderr: String(stderr) });
    });
  });
}

/** The commands that write the entry through the client's own CLI. */
function clientCommands(
  program: "claude" | "codex",
  launcher: Launcher,
): Array<{ args: string[]; mayFail: boolean }> {
  if (program === "claude") {
    const json = JSON.stringify({ type: "stdio", command: launcher.command, args: launcher.args });
    return [
      // `add-json` refuses a name that exists, so a stale entry goes first.
      { args: ["mcp", "remove", SERVER_NAME, "--scope", "user"], mayFail: true },
      { args: ["mcp", "add-json", SERVER_NAME, json, "--scope", "user"], mayFail: false },
    ];
  }
  return [
    {
      args: ["mcp", "add", SERVER_NAME, "--", launcher.command, ...launcher.args],
      mayFail: false,
    },
  ];
}

export type InstallResult = {
  client: McpClient;
  server: string;
  file: string;
  entry: Launcher;
  via?: string[];
  dryRun: boolean;
};

/** Adds or replaces the `lazco` entry of one client, or with `dryRun` only says what it would do. */
export async function installClient(options: {
  client: McpClient;
  paths: PathEnvironment;
  launcher: Launcher;
  dryRun: boolean;
}): Promise<InstallResult> {
  const target = targetOf(options.client, options.paths, options.launcher);
  const base = {
    client: options.client,
    server: SERVER_NAME,
    entry: options.launcher,
    dryRun: options.dryRun,
  };
  if (target.kind === "command") {
    const program = await findOnPath(target.program, options.paths);
    if (!program) {
      throw invalid(
        `The ${target.program} command was not found on PATH, and ${options.client} adds servers only through it`,
        "client",
        `needs ${target.program} on PATH`,
      );
    }
    const commands = clientCommands(target.program, options.launcher);
    const via = [program, ...(commands.at(-1)?.args ?? [])];
    if (!options.dryRun) {
      for (const command of commands) {
        const result = await run(program, command.args, options.paths.env);
        if (result.code !== 0 && !command.mayFail) {
          throw new CliError(
            "CLI_INTERNAL",
            `${target.program} ${command.args.slice(0, 2).join(" ")} failed`,
            { exitCode: result.code, stderr: result.stderr.trim().slice(0, 2000) },
          );
        }
      }
    }
    return { ...base, file: target.file, via };
  }
  let text = "";
  try {
    text = await readFile(target.path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const updated = withEntry(text, target.path, target.key, target.entry);
  if (!options.dryRun) {
    await writeFileAtomic(target.path, updated);
  }
  return { ...base, file: target.path };
}
