import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packageSpec } from "../../src/mcp/install";
import { cliEnv, FAKE_TOKEN, makeHome, runInProcess } from "../helpers/cli";

let home: Awaited<ReturnType<typeof makeHome>>;
let bin: string;

beforeEach(async () => {
  home = await makeHome();
  bin = join(home.home, "bin");
  await mkdir(bin, { recursive: true });
});

afterEach(async () => {
  await home.cleanup();
});

/** An executable shell script in the test's `bin`, which records its arguments, one per line. */
async function fakeProgram(name: string): Promise<string> {
  const path = join(bin, name);
  await writeFile(
    path,
    `#!/bin/sh\nfor argument in "$@"; do printf '%s\\n' "$argument"; done >> "${path}.calls"\nprintf '=end=\\n' >> "${path}.calls"\n`,
  );
  await chmod(path, 0o755);
  return path;
}

async function calls(program: string): Promise<string[][]> {
  const text = await readFile(`${program}.calls`, "utf8");
  return text
    .split("=end=\n")
    .filter(Boolean)
    .map((call) => call.trimEnd().split("\n"));
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return cliEnv(home.home, {
    PATH: bin,
    APPDATA: join(home.home, "appdata"),
    XDG_CONFIG_HOME: join(home.home, "xdg"),
    NO_COLOR: "1",
    ...extra,
  });
}

async function install(
  args: readonly string[],
  options: { platform?: NodeJS.Platform; env?: Record<string, string> } = {},
) {
  const run = await runInProcess(["mcp", "install", ...args], {
    env: options.env ?? env(),
    platform: options.platform,
  });
  return {
    ...run,
    record: run.code === 0 ? JSON.parse(run.stdout) : undefined,
    error: run.code === 0 ? undefined : JSON.parse(run.stderr.trim().split("\n").at(-1) as string),
  };
}

async function readJson(path: string): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(await readFile(path, "utf8"));
}

const FILE_CLIENTS: ReadonlyArray<[string, NodeJS.Platform, string[]]> = [
  ["cursor", "linux", [".cursor", "mcp.json"]],
  ["gemini", "linux", [".gemini", "settings.json"]],
  ["pi", "darwin", [".pi", "agent", "mcp.json"]],
  ["vscode", "linux", [".copilot", "mcp-config.json"]],
  ["devin", "linux", ["xdg", "devin", "mcp_config.json"]],
  ["devin", "win32", ["appdata", "devin", "mcp_config.json"]],
  [
    "claude-desktop",
    "darwin",
    ["Library", "Application Support", "Claude", "claude_desktop_config.json"],
  ],
  ["claude-desktop", "win32", ["appdata", "Claude", "claude_desktop_config.json"]],
];

describe("lazco mcp install", () => {
  for (const [client, platform, segments] of FILE_CLIENTS) {
    test(`${client} on ${platform} gets an entry with the global lazco`, async () => {
      const lazco = await fakeProgram(platform === "win32" ? "lazco.EXE" : "lazco");
      const run = await install(["--client", client], { platform });
      expect(run.stderr).toBe("");
      const file = join(home.home, ...segments);
      expect(run.record).toMatchObject({ client, server: "lazco", file, dryRun: false });
      const written = await readJson(file);
      expect(written.mcpServers?.lazco).toEqual({ command: lazco, args: ["mcp"] });
    });
  }

  test("a commented JSONC file keeps its comments and its other entries", async () => {
    await fakeProgram("lazco");
    const file = join(home.home, ".copilot", "mcp-config.json");
    await mkdir(join(home.home, ".copilot"), { recursive: true });
    const original = `{
    // my servers
    "mcpServers": {
        "other": { "command": "/bin/other", "args": [] }, // keep me
        "lazco": { "command": "/old/lazco", "args": ["mcp"] }
    },
    "theme": "dark",
}
`;
    await writeFile(file, original);
    const run = await install(["--client", "vscode", "--allow-writes"]);
    expect(run.code).toBe(0);
    const text = await readFile(file, "utf8");
    expect(text).toContain("// my servers");
    expect(text).toContain("// keep me");
    expect(text).toContain('"other": { "command": "/bin/other", "args": [] }');
    expect(text).toContain('"theme": "dark"');
    expect(text).toContain(`"command": "${join(bin, "lazco")}"`);
    expect(text).not.toContain("/old/lazco");
    expect(text).toContain('"--allow-writes"');
  });

  test("a config file that is a symlink stays a symlink, and its target gets the entry", async () => {
    const lazco = await fakeProgram("lazco");
    const dotfiles = join(home.home, "dotfiles");
    await mkdir(dotfiles, { recursive: true });
    await mkdir(join(home.home, ".cursor"), { recursive: true });
    const real = join(dotfiles, "cursor-mcp.json");
    await writeFile(real, '{ "mcpServers": { "other": { "command": "/bin/other" } } }\n');
    const link = join(home.home, ".cursor", "mcp.json");
    await symlink(real, link);
    const run = await install(["--client", "cursor"], { platform: "linux" });
    expect(run.code).toBe(0);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    const written = await readJson(real);
    expect(written.mcpServers?.lazco).toEqual({ command: lazco, args: ["mcp"] });
    expect(written.mcpServers?.other).toEqual({ command: "/bin/other" });
  });

  test("the entry holds no credential, and --profile and --api-url go into its arguments", async () => {
    await fakeProgram("lazco");
    const configDirectory = join(home.home, "xdg", "lazco");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "config.json"),
      JSON.stringify({
        version: 1,
        currentProfile: "staging",
        profiles: {
          staging: {
            apiUrl: "https://api-staging.lazco.tw/v1",
            organization: { id: "org-1", name: "Org" },
            method: "token",
            credential: { store: "file", token: FAKE_TOKEN },
          },
        },
      }),
    );
    const run = await install(
      ["--client", "cursor", "--profile", "staging", "--api-url", "https://api-staging.lazco.tw"],
      { env: env({ LAZCO_TOKEN: FAKE_TOKEN }) },
    );
    expect(run.code).toBe(0);
    const text = await readFile(join(home.home, ".cursor", "mcp.json"), "utf8");
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(FAKE_TOKEN.slice(-8));
    expect(text).not.toContain("LAZCO_TOKEN");
    expect((await readJson(join(home.home, ".cursor", "mcp.json"))).mcpServers?.lazco).toEqual({
      command: join(bin, "lazco"),
      args: ["mcp", "--profile", "staging", "--api-url", "https://api-staging.lazco.tw/v1"],
    });
  });

  test("an unknown --profile is CLI_INVALID_INPUT and writes nothing", async () => {
    await fakeProgram("lazco");
    const run = await install(["--client", "cursor", "--profile", "nobody"]);
    expect(run.error.error.code).toBe("CLI_INVALID_INPUT");
    await expect(stat(join(home.home, ".cursor"))).rejects.toThrow();
  });

  test("--dry-run prints the entry and the file and writes nothing", async () => {
    await fakeProgram("lazco");
    const run = await install(["--client", "gemini", "--dry-run"]);
    expect(run.record).toEqual({
      client: "gemini",
      server: "lazco",
      file: join(home.home, ".gemini", "settings.json"),
      entry: { command: join(bin, "lazco"), args: ["mcp"] },
      dryRun: true,
    });
    await expect(stat(join(home.home, ".gemini"))).rejects.toThrow();
  });

  test("claude-desktop on Linux is CLI_INVALID_INPUT", async () => {
    await fakeProgram("lazco");
    const run = await install(["--client", "claude-desktop"], { platform: "linux" });
    expect(run.error.error.code).toBe("CLI_INVALID_INPUT");
  });

  test("an unknown client is CLI_INVALID_INPUT", async () => {
    const run = await install(["--client", "zed"]);
    expect(run.error.error.code).toBe("CLI_INVALID_INPUT");
  });

  test("a file that is not JSON is left as it is", async () => {
    await fakeProgram("lazco");
    await mkdir(join(home.home, ".cursor"), { recursive: true });
    await writeFile(join(home.home, ".cursor", "mcp.json"), "{ not json");
    const run = await install(["--client", "cursor"]);
    expect(run.error.error.code).toBe("CLI_INVALID_INPUT");
    expect(await readFile(join(home.home, ".cursor", "mcp.json"), "utf8")).toBe("{ not json");
  });

  test("without a global lazco, the entry starts the package with npx", async () => {
    const npx = await fakeProgram("npx");
    const run = await install(["--client", "pi"]);
    expect(run.record.entry).toEqual({ command: npx, args: ["-y", "@lazco/cli", "mcp"] });
  });

  test("the runner that started lazco wins, without -y for bunx", async () => {
    await fakeProgram("npx");
    const bunx = await fakeProgram("bunx");
    const run = await install(["--client", "pi"], {
      env: env({ npm_config_user_agent: "bun/1.4.2 npm/? node/v24.3.0 darwin arm64" }),
    });
    expect(run.record.entry).toEqual({ command: bunx, args: ["@lazco/cli", "mcp"] });
  });

  test("a lazco inside the npx cache is not a global install", async () => {
    const cache = join(home.home, ".npm", "_npx", "abc", "node_modules", ".bin");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "lazco"), "#!/bin/sh\n");
    await chmod(join(cache, "lazco"), 0o755);
    const npx = await fakeProgram("npx");
    const run = await install(["--client", "pi"], { env: env({ PATH: `${cache}:${bin}` }) });
    expect(run.record.entry.command).toBe(npx);
  });

  test("no lazco and no runner is CLI_INVALID_INPUT", async () => {
    const run = await install(["--client", "pi"]);
    expect(run.error.error.code).toBe("CLI_INVALID_INPUT");
  });

  test("claude-code goes through claude mcp add-json at user scope, after a remove", async () => {
    const lazco = await fakeProgram("lazco");
    const claude = await fakeProgram("claude");
    const run = await install(["--client", "claude-code", "--allow-writes"]);
    expect(run.code).toBe(0);
    expect(run.record.file).toBe(join(home.home, ".claude.json"));
    const json = JSON.stringify({ type: "stdio", command: lazco, args: ["mcp", "--allow-writes"] });
    expect(await calls(claude)).toEqual([
      ["mcp", "remove", "lazco", "--scope", "user"],
      ["mcp", "add-json", "lazco", json, "--scope", "user"],
    ]);
  });

  test("codex goes through codex mcp add", async () => {
    const lazco = await fakeProgram("lazco");
    const codex = await fakeProgram("codex");
    const run = await install(["--client", "codex"]);
    expect(run.code).toBe(0);
    expect(run.record.file).toBe(join(home.home, ".codex", "config.toml"));
    expect(await calls(codex)).toEqual([["mcp", "add", "lazco", "--", lazco, "mcp"]]);
  });

  test("--dry-run of claude-code runs nothing", async () => {
    await fakeProgram("lazco");
    const claude = await fakeProgram("claude");
    const run = await install(["--client", "claude-code", "--dry-run"]);
    expect(run.record.via[0]).toBe(claude);
    await expect(stat(`${claude}.calls`)).rejects.toThrow();
  });

  for (const client of ["claude-code", "codex"]) {
    test(`a missing command for ${client} is CLI_INVALID_INPUT`, async () => {
      await fakeProgram("lazco");
      const run = await install(["--client", client]);
      expect(run.error.error.code).toBe("CLI_INVALID_INPUT");
    });
  }

  test("the package is unpinned on 0.x and pinned to its major from 1.0", () => {
    expect(packageSpec("0.3.0")).toBe("@lazco/cli");
    expect(packageSpec("1.4.2")).toBe("@lazco/cli@1");
  });
});
