import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { panelUrl } from "../../src/commands/auth";
import { type Config, writeConfig } from "../../src/config/configFile";
import { cliEnv, FAKE_TOKEN, makeHome, ndjson, runInProcess } from "../helpers/cli";
import { FakeApi, json } from "../helpers/fakeApi";
import { fixtureApi } from "../helpers/fixtureApi";
import { accountOf, memoryKeychain } from "../helpers/keychain";

const STAGING_URL = "https://api-staging.lazco.tw/v1";
const FILE_TOKEN = `lz_live_${"0".repeat(48)}${"f1".repeat(8)}`;

let api: FakeApi;
let home: Awaited<ReturnType<typeof makeHome>>;
let keychain: ReturnType<typeof memoryKeychain>;
let configPath: string;

const organization = { id: "org-1", name: "Fixture Org" };

async function seed(config: Partial<Config> = {}): Promise<void> {
  await writeConfig(configPath, {
    version: 1,
    currentProfile: "default",
    profiles: {
      default: {
        apiUrl: api.apiUrl,
        organization,
        credential: { store: "keychain", account: accountOf("default") },
      },
      plain: { apiUrl: api.apiUrl, organization, credential: { store: "file", token: FILE_TOKEN } },
      staging: {
        apiUrl: STAGING_URL,
        organization,
        credential: { store: "keychain", account: accountOf("staging") },
      },
    },
    ...config,
  });
}

beforeEach(async () => {
  api = fixtureApi();
  home = await makeHome();
  configPath = join(home.home, "config", "lazco", "config.json");
  keychain = memoryKeychain();
  keychain.entries.set(accountOf("default"), FAKE_TOKEN);
  keychain.entries.set(accountOf("staging"), `lz_live_${"0".repeat(48)}${"5a".repeat(8)}`);
  await seed();
});

afterEach(async () => {
  api.stop();
  await home.cleanup();
});

function run(args: readonly string[], extra: Record<string, string> = {}) {
  return runInProcess(args, { env: cliEnv(home.home, extra), keychain });
}

function errorOf(stderr: string): { code: string; message: string; status?: number } {
  return JSON.parse(stderr.trim().split("\n").at(-1) as string).error;
}

async function storedConfig(): Promise<Config> {
  return JSON.parse(await readFile(configPath, "utf8"));
}

describe("lazco auth status", () => {
  test("a keychain profile shows the store and the whoami fields", async () => {
    const result = await run(["auth", "status"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      profile: "default",
      apiUrl: api.apiUrl,
      store: "keychain",
      organization: { id: "org-1", name: "Fixture Org" },
      role: "owner",
      scope: "read_write",
      expiresAt: null,
    });
  });

  test("a file profile shows the store and the file's path", async () => {
    const result = await run(["auth", "status", "--profile", "plain"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      profile: "plain",
      store: "file",
      path: configPath,
    });
    expect(result.stdout).not.toContain(FILE_TOKEN.slice(-8));
  });

  test("LAZCO_TOKEN shows as env", async () => {
    const result = await run(["--api-url", api.apiUrl, "auth", "status"], {
      LAZCO_TOKEN: FAKE_TOKEN,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ profile: "env", store: "env" });
  });

  test("a refused credential prints the API's error and exits with 1", async () => {
    const refusing = new FakeApi(() =>
      json(401, { error: "Token expired", code: "TOKEN_EXPIRED", timestamp: "t" }),
    );
    try {
      const result = await run(["--api-url", refusing.apiUrl, "auth", "status"], {
        LAZCO_TOKEN: FAKE_TOKEN,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(errorOf(result.stderr)).toMatchObject({ status: 401, code: "TOKEN_EXPIRED" });
    } finally {
      refusing.stop();
    }
  });

  test("no sign-in is CLI_NOT_LOGGED_IN", async () => {
    await seed({ currentProfile: undefined });
    const result = await run(["auth", "status"]);
    expect(errorOf(result.stderr).code).toBe("CLI_NOT_LOGGED_IN");
  });
});

describe("lazco auth logout", () => {
  test("it removes the keychain entry and the profile, and names the panel page", async () => {
    const result = await run(["auth", "logout", "--profile", "staging"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ profile: "staging", loggedOut: true });
    expect(result.stderr).toContain("https://cloud-staging.lazco.tw/dashboard/api");
    expect(keychain.entries.has(accountOf("staging"))).toBe(false);
    expect(keychain.entries.has(accountOf("default"))).toBe(true);
    const listed = await run(["profile", "list"]);
    expect((ndjson(listed.stdout) as Array<{ name: string }>).map((line) => line.name)).toEqual([
      "default",
      "plain",
    ]);
  });

  test("logging out of the current profile leaves no current profile", async () => {
    const result = await run(["auth", "logout"]);
    expect(result.code).toBe(0);
    expect(keychain.entries.has(accountOf("default"))).toBe(false);
    const config = await storedConfig();
    expect(config.currentProfile).toBeUndefined();
    expect(Object.keys(config.profiles)).toEqual(["plain", "staging"]);
  });

  test("a file profile's token leaves the config file", async () => {
    await run(["auth", "logout", "--profile", "plain"]);
    expect(await readFile(configPath, "utf8")).not.toContain(FILE_TOKEN);
  });

  test("with LAZCO_TOKEN and no --profile it is CLI_INVALID_INPUT", async () => {
    const result = await run(["auth", "logout"], { LAZCO_TOKEN: FAKE_TOKEN });
    expect(result.code).toBe(1);
    expect(errorOf(result.stderr).code).toBe("CLI_INVALID_INPUT");
    expect(keychain.entries.has(accountOf("default"))).toBe(true);
  });

  test("with LAZCO_TOKEN and --profile it forgets that profile", async () => {
    const result = await run(["auth", "logout", "--profile", "default"], {
      LAZCO_TOKEN: FAKE_TOKEN,
    });
    expect(result.code).toBe(0);
    expect(keychain.entries.has(accountOf("default"))).toBe(false);
  });

  test("an unknown profile is CLI_INVALID_INPUT", async () => {
    const result = await run(["auth", "logout", "--profile", "nope"]);
    expect(errorOf(result.stderr).code).toBe("CLI_INVALID_INPUT");
  });

  for (const name of ["constructor", "toString", "hasOwnProperty"]) {
    test(`a profile named ${name} is a profile, not a property of the object`, async () => {
      const logout = await run(["auth", "logout", "--profile", name]);
      expect(errorOf(logout.stderr).code).toBe("CLI_INVALID_INPUT");
      const status = await run(["auth", "status", "--profile", name]);
      expect(errorOf(status.stderr).code).toBe("CLI_INVALID_INPUT");
    });
  }
});

describe("lazco profile list and profile use", () => {
  test("list prints one line per profile and never a credential", async () => {
    const result = await run(["profile", "list"]);
    expect(result.code).toBe(0);
    expect(ndjson(result.stdout)).toEqual([
      { name: "default", apiUrl: api.apiUrl, organization, store: "keychain", current: true },
      { name: "plain", apiUrl: api.apiUrl, organization, store: "file", current: false },
      { name: "staging", apiUrl: STAGING_URL, organization, store: "keychain", current: false },
    ]);
    expect(result.stdout).not.toContain(FILE_TOKEN.slice(-8));
  });

  test("use makes a profile current", async () => {
    const used = await run(["profile", "use", "staging"]);
    expect(used.code).toBe(0);
    expect(JSON.parse(used.stdout)).toEqual({ profile: "staging", current: true });
    const listed = ndjson((await run(["profile", "list"])).stdout) as Array<{
      name: string;
      current: boolean;
    }>;
    expect(listed.filter((line) => line.current).map((line) => line.name)).toEqual(["staging"]);
  });

  test("use of an unknown name is CLI_INVALID_INPUT and changes nothing", async () => {
    const result = await run(["profile", "use", "nope"]);
    expect(result.code).toBe(1);
    expect(errorOf(result.stderr).code).toBe("CLI_INVALID_INPUT");
    expect((await storedConfig()).currentProfile).toBe("default");
  });

  test("use without a name is CLI_INVALID_INPUT", async () => {
    const result = await run(["profile", "use"]);
    expect(errorOf(result.stderr).code).toBe("CLI_INVALID_INPUT");
  });

  test("a broken config file is CLI_INVALID_INPUT naming it", async () => {
    await Bun.write(configPath, "{");
    const result = await run(["profile", "list"]);
    expect(result.code).toBe(1);
    const error = errorOf(result.stderr);
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.message).toContain(configPath);
  });
});

describe("the panel URL", () => {
  test("api becomes cloud on lazco.tw hosts only", () => {
    expect(panelUrl("https://api.lazco.tw/v1")).toBe("https://cloud.lazco.tw");
    expect(panelUrl("https://api-staging.lazco.tw/v1")).toBe("https://cloud-staging.lazco.tw");
    expect(panelUrl("https://api.example.com/v1")).toBeUndefined();
    expect(panelUrl("http://127.0.0.1:8080/v1")).toBeUndefined();
  });
});
