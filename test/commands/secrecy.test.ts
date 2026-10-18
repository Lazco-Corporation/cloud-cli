import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeConfig } from "../../src/config/configFile";
import { type CliRun, cliEnv, FAKE_TOKEN, makeHome, runInProcess } from "../helpers/cli";
import { FakeApi, json } from "../helpers/fakeApi";
import { fixtureApi } from "../helpers/fixtureApi";
import { brokenKeychain, memoryKeychain } from "../helpers/keychain";

const KEYCHAIN_TOKEN = `lz_live_${"0".repeat(48)}beefbeef12345678`;
const FILE_TOKEN = `lz_live_${"0".repeat(48)}f11ef11e87654321`;
const LOGIN_TOKEN = `lz_live_${"0".repeat(48)}10910910abcdef01`;
const FILE_LOGIN_TOKEN = `lz_live_${"0".repeat(48)}f10f10f1fedcba98`;
const TOKENS = [FAKE_TOKEN, KEYCHAIN_TOKEN, FILE_TOKEN, LOGIN_TOKEN, FILE_LOGIN_TOKEN];

/** Every command of the `surface` fixture, and the error paths of the shell. */
const COMMANDS: string[][] = [
  ["--describe"],
  ["--help"],
  ["compute", "--describe"],
  ["compute", "list"],
  ["compute", "list", "--page-all"],
  ["compute", "list", "--human"],
  ["compute", "get", "srv-1"],
  ["compute", "get", "srv-1", "--dry-run"],
  ["compute", "create", "--hostname", "web", "--region-slug", "txg1", "--plan-slug", "s1"],
  [
    "compute",
    "create",
    "--hostname",
    "web",
    "--region-slug",
    "txg1",
    "--plan-slug",
    "s1",
    "--yes",
    "--no-wait",
  ],
  [
    "compute",
    "create",
    "--hostname",
    "web",
    "--region-slug",
    "txg1",
    "--plan-slug",
    "s1",
    "--dry-run",
  ],
  ["compute", "delete", "srv-1", "--yes"],
  ["compute", "delete", "srv-1", "--confirm-hostname", "web-1", "--yes", "--no-wait"],
  ["compute", "power", "set", "srv-1", "--action", "reboot"],
  ["compute", "snapshots", "delete", "srv-1", "snap-1", "--yes"],
  ["notifications", "list"],
  ["dns", "records", "list", "z-1"],
  ["dns", "records", "set", "z-1", "--json", '{"rrsets":[]}'],
  ["dns", "records", "set", "z-1", "--json", '{"rrsets":[]}', "--dry-run"],
  ["regions", "list"],
  ["ssh-keys", "create", "--name", "key", "--public-key", "ssh-ed25519 AAAA"],
  ["firewall", "rules", "set", "fw-1", "--json", '{"rules":[]}'],
  ["projects", "update", "p-1", "--json", '{"body":{}}'],
  ["tags", "bulk", "create", "--json", '{"body":[]}'],
  ["tasks", "get", "t-1"],
  ["compute", "get", "srv%2f..%2fx"],
  ["compute", "get"],
  ["compute"],
  ["no-such-command"],
  ["compute", "list", "--human", "--fields", "id"],
  ["auth", "status"],
  ["auth", "status", "--human"],
  ["profile", "list"],
];

/**
 * An API that serves the fixture spec and a working `whoami`, and answers
 * every other request with an error that echoes the credential it received:
 * in the message, in a field, in a key, and in an HTML 502.
 */
function echoingApi(): FakeApi {
  const fixture = fixtureApi();
  return new FakeApi(async (request) => {
    if (request.path === "/v1/spec" || request.path === "/v1/whoami") {
      return fixture.handler(request);
    }
    const sent = request.headers.authorization ?? "none";
    if (request.path.startsWith("/v1/regions")) {
      return new Response(`<html>bad gateway for ${sent}</html>`, {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    }
    return json(400, {
      error: `rejected ${sent}`,
      code: "ECHO",
      details: `the header was ${sent}`,
      [sent]: sent,
      timestamp: "t",
    });
  });
}

let normalApi: FakeApi;
let echoApi: FakeApi;
let home: Awaited<ReturnType<typeof makeHome>>;
let configPath: string;
const keychain = memoryKeychain();
const outputs: Array<{ args: string[]; run: CliRun }> = [];

async function run(
  args: string[],
  options: { env?: Record<string, string>; stdin?: string; broken?: boolean } = {},
) {
  const result = await runInProcess(args, {
    env: cliEnv(home.home, { NO_COLOR: "1", ...options.env }),
    keychain: options.broken ? brokenKeychain() : keychain,
    stdin: options.stdin,
  });
  outputs.push({ args, run: result });
  return result;
}

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

beforeAll(async () => {
  normalApi = fixtureApi();
  echoApi = echoingApi();
  home = await makeHome();
  configPath = join(home.home, "config", "lazco", "config.json");
  const organization = { id: "org-1", name: "Fixture Org" };
  await writeConfig(configPath, {
    version: 1,
    currentProfile: "kc-normal",
    profiles: {
      "kc-normal": { apiUrl: normalApi.apiUrl, organization, credential: { store: "keychain" } },
      "kc-echo": { apiUrl: echoApi.apiUrl, organization, credential: { store: "keychain" } },
      "file-echo": {
        apiUrl: echoApi.apiUrl,
        organization,
        credential: { store: "file", token: FILE_TOKEN },
      },
    },
  });
  keychain.entries.set("kc-normal", KEYCHAIN_TOKEN);
  keychain.entries.set("kc-echo", KEYCHAIN_TOKEN);
});

afterAll(async () => {
  normalApi.stop();
  echoApi.stop();
  await home.cleanup();
});

describe("no credential is ever shown", () => {
  test("every command and error path, with each credential source", async () => {
    for (const api of [normalApi, echoApi]) {
      for (const args of COMMANDS) {
        await run(["--api-url", api.apiUrl, ...args], { env: { LAZCO_TOKEN: FAKE_TOKEN } });
      }
    }
    for (const profile of ["kc-normal", "kc-echo", "file-echo"]) {
      for (const args of COMMANDS) {
        await run(["--profile", profile, ...args]);
      }
    }
    await run(["--api-url", echoApi.apiUrl, "--profile", "kc-normal", "compute", "list"]);
    await run(["compute", "list"], { env: { LAZCO_PROFILE: "file-echo" } });

    await run(
      ["--api-url", normalApi.apiUrl, "--profile", "login", "auth", "login", "--with-token"],
      {
        stdin: LOGIN_TOKEN,
      },
    );
    await run(["--profile", "login", "auth", "status"]);
    await run(["--profile", "login", "compute", "list"]);
    await run(
      ["--api-url", normalApi.apiUrl, "--profile", "file-login", "auth", "login", "--with-token"],
      {
        stdin: FILE_LOGIN_TOKEN,
        broken: true,
      },
    );
    await run(["--profile", "file-login", "auth", "status"]);
    await run(["--api-url", echoApi.apiUrl, "auth", "login", "--with-token", "--profile", "x"], {
      stdin: `${LOGIN_TOKEN.slice(0, -1)}Z`,
    });
    await run(["profile", "use", "login"]);
    await run(["profile", "list"]);
    await run(["--profile", "login", "auth", "logout"]);
    await run(["--profile", "kc-echo", "auth", "logout"]);

    expect(outputs.length).toBeGreaterThan(COMMANDS.length * 5);
    expect(echoApi.requests.some((request) => request.headers.authorization)).toBe(true);
    expect(outputs.some(({ run: result }) => result.stderr.includes("[REDACTED]"))).toBe(true);

    for (const { args, run: result } of outputs) {
      for (const token of TOKENS) {
        for (const text of [result.stdout, result.stderr]) {
          if (text.includes(token) || text.includes(token.slice(-8))) {
            throw new Error(`lazco ${args.join(" ")} printed a credential: ${text}`);
          }
        }
      }
    }

    const files = await filesBelow(home.home);
    expect(files).toContain(configPath);
    expect(files.some((file) => file.includes(join("lazco", "spec")))).toBe(true);
    expect(files.some((file) => file.includes(join("lazco", "whoami")))).toBe(true);
    const config = await readFile(configPath, "utf8");
    expect(config).toContain(FILE_TOKEN);
    expect(config).toContain(FILE_LOGIN_TOKEN);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const token of TOKENS) {
        const fileStoreHoldsIt =
          file === configPath && (token === FILE_TOKEN || token === FILE_LOGIN_TOKEN);
        if (fileStoreHoldsIt) {
          continue;
        }
        expect({ file, holds: text.includes(token) || text.includes(token.slice(-8)) }).toEqual({
          file,
          holds: false,
        });
      }
    }
  }, 120_000);
});
