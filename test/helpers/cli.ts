import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { HandwrittenCommand } from "../../src/commands/types";
import { writeFileAtomic } from "../../src/config/atomicFile";
import { sha256Hex } from "../../src/config/paths";
import type { OpenApiDocument } from "../../src/core/spec/types";
import type { Keychain } from "../../src/credentials/keychain";
import type { Io } from "../../src/shell/io";
import { runCli } from "../../src/shell/run";
import { memoryKeychain } from "./keychain";

export const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");
export const FAKE_TOKEN =
  "lz_live_000000000000000000000000000000000000000000000000feedfacecafe0001";

export type CliRun = { code: number; stdout: string; stderr: string };

/** A temporary HOME and cache for one test, so nothing touches the real ones. */
export async function makeHome(): Promise<{
  home: string;
  cache: string;
  cleanup: () => Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), "lazco-home-"));
  const cache = join(home, "cache");
  return { home, cache, cleanup: () => rm(home, { recursive: true, force: true }) };
}

export function cliEnv(
  home: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_CONFIG_HOME: join(home, "config"),
    ...extra,
  };
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** Runs `lazco` as a child process with pipes, as a script would. */
export async function runLazco(
  args: readonly string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<CliRun> {
  const child = Bun.spawn(["bun", CLI_PATH, ...args], {
    env,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * Runs `lazco` on a pseudo-terminal, which holds stdin, stdout and stderr
 * alike. Each answer is typed once the output so far contains its prompt.
 */
export async function runLazcoOnTerminal(
  args: readonly string[],
  env: Record<string, string>,
  answers: ReadonlyArray<{ after: string; type: string }> = [],
): Promise<{ code: number; output: string }> {
  let output = "";
  const pending = [...answers];
  const child = Bun.spawn(["bun", CLI_PATH, ...args], {
    env,
    terminal: {
      cols: 200,
      rows: 50,
      data(terminal, data) {
        output += new TextDecoder().decode(data);
        const next = pending[0];
        if (next && output.includes(next.after)) {
          pending.shift();
          terminal.write(`${next.type}\r`);
        }
      },
    },
  });
  const code = await child.exited;
  await Bun.sleep(50);
  return { code, output: output.replaceAll("\r\n", "\n") };
}

/** Puts a fresh copy of a spec in the cache, so a run sends no request for it. */
export async function seedSpecCache(
  cache: string,
  apiUrl: string,
  spec: OpenApiDocument,
  checkedAt = Date.now(),
): Promise<string> {
  const path = join(cache, "lazco", "spec", `${sha256Hex(apiUrl)}.json`);
  await writeFileAtomic(path, JSON.stringify({ apiUrl, etag: '"seed"', checkedAt, spec }));
  return path;
}

/**
 * Runs `lazco` in this process with captured output, with the hand-written
 * commands and the keychain a test supplies. Without a keychain, one in
 * memory is used, so no test touches the real one.
 */
export async function runInProcess(
  args: readonly string[],
  options: {
    env: Record<string, string>;
    handwritten?: readonly HandwrittenCommand[];
    keychain?: Keychain;
    stdin?: string;
    platform?: NodeJS.Platform;
  },
): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const stdin = new PassThrough();
  stdin.end(options.stdin ?? "");
  const io: Io = {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    stdin,
    env: options.env,
  };
  const code = await runCli(args, io, {
    handwritten: options.handwritten,
    keychain: options.keychain ?? memoryKeychain(),
    paths: {
      env: options.env,
      platform: options.platform ?? process.platform,
      home: options.env.HOME as string,
    },
  });
  return { code, stdout, stderr };
}

/** Each line of NDJSON output as a value. */
export function ndjson(text: string): unknown[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}
