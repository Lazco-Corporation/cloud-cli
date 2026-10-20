import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HANDWRITTEN_COMMANDS } from "../../src/commands/registry";
import { sha256Hex } from "../../src/config/paths";
import { CliError } from "../../src/core/errors";
import { normalizeApiUrl } from "../../src/shell/apiUrl";
import { cliEnv, FAKE_TOKEN, makeHome, ndjson, runLazco } from "../helpers/cli";
import type { FakeApi } from "../helpers/fakeApi";
import { fixtureApi, operationRequests } from "../helpers/fixtureApi";

let api: FakeApi;
let home: Awaited<ReturnType<typeof makeHome>>;

beforeEach(async () => {
  api = fixtureApi({ features: { dns: false, t4: true } });
  home = await makeHome();
});

afterEach(async () => {
  api.stop();
  await home.cleanup();
});

const signedIn = () => cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN, NO_COLOR: "1" });

function commandsOf(stdout: string): string[] {
  return (ndjson(stdout) as Array<{ command: string }>).map((line) => line.command);
}

describe("feature hiding", () => {
  test("a command whose feature is off leaves --describe and --help", async () => {
    const described = await runLazco(["--api-url", api.apiUrl, "--describe"], signedIn());
    expect(described.code).toBe(0);
    const commands = commandsOf(described.stdout);
    expect(commands).toHaveLength(14 + HANDWRITTEN_COMMANDS.length);
    expect(commands.filter((command) => command.startsWith("dns "))).toEqual([]);
    const help = await runLazco(["--api-url", api.apiUrl, "--help"], signedIn());
    expect(help.stdout).toContain("compute");
    expect(help.stdout).not.toMatch(/\bdns\b/);
  });

  test("it still runs by name, so the API's own answer reaches the user", async () => {
    const run = await runLazco(
      ["--api-url", api.apiUrl, "dns", "records", "list", "z-1"],
      signedIn(),
    );
    expect(run.code).toBe(0);
    expect(operationRequests(api.requests)).toEqual(["GET /v1/dns/zones/z-1/rrsets"]);
    expect(api.requests.map((request) => request.path)).not.toContain("/v1/whoami");
  });

  test("with no credential nothing is hidden and whoami is not asked", async () => {
    const run = await runLazco(["--api-url", api.apiUrl, "--describe"], cliEnv(home.home));
    expect(commandsOf(run.stdout)).toHaveLength(16 + HANDWRITTEN_COMMANDS.length);
    expect(api.requests.map((request) => request.path)).not.toContain("/v1/whoami");
  });

  test("the whoami cache is named by a hash and holds no credential", async () => {
    await runLazco(["--api-url", api.apiUrl, "--describe"], signedIn());
    const directory = join(home.cache, "lazco", "whoami");
    expect(await readdir(directory)).toEqual([`${sha256Hex(FAKE_TOKEN)}.json`]);
    const content = await readFile(join(directory, `${sha256Hex(FAKE_TOKEN)}.json`), "utf8");
    expect(content).not.toContain(FAKE_TOKEN.slice(-8));
    expect(JSON.parse(content)).toMatchObject({
      apiUrl: api.apiUrl,
      whoami: { features: { dns: false } },
    });

    const whoamiReads = () =>
      api.requests.filter((request) => request.path === "/v1/whoami").length;
    expect(whoamiReads()).toBe(1);
    await runLazco(["--api-url", api.apiUrl, "--describe"], signedIn());
    expect(whoamiReads()).toBe(1);
  });

  test("a whoami that fails hides nothing and warns", async () => {
    const handler = api.handler;
    api.handler = (request) =>
      request.path === "/v1/whoami"
        ? new Response("{}", { status: 401, headers: { "content-type": "application/json" } })
        : handler(request);
    const run = await runLazco(["--api-url", api.apiUrl, "--describe"], signedIn());
    expect(run.code).toBe(0);
    expect(commandsOf(run.stdout)).toHaveLength(16 + HANDWRITTEN_COMMANDS.length);
    expect(run.stderr).toContain("no command is hidden");
  });
});

describe("--api-url", () => {
  test("plain HTTP to a remote host is refused", async () => {
    const run = await runLazco(
      ["--api-url", "http://api.example.com/v1", "compute", "list"],
      signedIn(),
    );
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(JSON.parse(run.stderr).error.code).toBe("CLI_INVALID_INPUT");
  });

  test("the accepted forms", () => {
    expect(normalizeApiUrl("https://api-staging.lazco.tw")).toBe("https://api-staging.lazco.tw/v1");
    expect(normalizeApiUrl("https://api-staging.lazco.tw/v1/")).toBe(
      "https://api-staging.lazco.tw/v1",
    );
    expect(normalizeApiUrl("http://127.0.0.1:3001")).toBe("http://127.0.0.1:3001/v1");
    expect(normalizeApiUrl("http://[::1]:3001/v1")).toBe("http://[::1]:3001/v1");
    expect(normalizeApiUrl("http://localhost:3001/v1")).toBe("http://localhost:3001/v1");
  });

  test("the refused forms", () => {
    for (const value of [
      "http://api.lazco.tw/v1",
      "http://127.0.0.1.example.com/v1",
      "ftp://api.lazco.tw/v1",
      "https://user:secret@api.lazco.tw/v1",
      "https://api.lazco.tw/v1?x=1",
      "api.lazco.tw",
    ]) {
      expect(() => normalizeApiUrl(value)).toThrow(CliError);
    }
  });

  test("the staging URL with or without /v1 reaches the same API", async () => {
    const withPath = await runLazco(["--api-url", api.apiUrl, "regions", "list"], signedIn());
    const bare = await runLazco(
      ["--api-url", api.apiUrl.replace(/\/v1$/, ""), "regions", "list"],
      signedIn(),
    );
    expect(bare.stdout).toBe(withPath.stdout);
    expect(operationRequests(api.requests)).toEqual(["GET /v1/regions", "GET /v1/regions"]);
  });
});
