import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  cliEnv,
  FAKE_TOKEN,
  makeHome,
  runInProcess,
  runLazco,
  runLazcoOnTerminal,
} from "../helpers/cli";
import { FakeApi, json } from "../helpers/fakeApi";
import { brokenKeychain, memoryKeychain, tokensOf } from "../helpers/keychain";

const OTHER_TOKEN = `lz_live_${"0".repeat(48)}${"12345678".repeat(2)}`;

let api: FakeApi;
let home: Awaited<ReturnType<typeof makeHome>>;
let configPath: string;

/** A `whoami` that knows two tokens, each of its own organization, and refuses the rest. */
function whoamiApi(): FakeApi {
  return new FakeApi((request) => {
    if (request.path !== "/v1/whoami") {
      return json(404, { error: "Not found", code: "NOT_FOUND" });
    }
    const organizations: Record<string, { id: string; name: string }> = {
      [`Bearer ${FAKE_TOKEN}`]: { id: "org-1", name: "First Org" },
      [`Bearer ${OTHER_TOKEN}`]: { id: "org-2", name: "Second Org" },
    };
    const organization = organizations[request.headers.authorization ?? ""];
    if (!organization) {
      return json(401, { error: "Invalid token", code: "UNAUTHORIZED", timestamp: "t" });
    }
    return json(200, {
      organization,
      role: "owner",
      principal: { kind: "api_token", scope: "read_write", expiresAt: null },
      features: {},
    });
  });
}

beforeEach(async () => {
  api = whoamiApi();
  home = await makeHome();
  configPath = join(home.home, "config", "lazco", "config.json");
});

afterEach(async () => {
  api.stop();
  await home.cleanup();
});

async function configText(): Promise<string | undefined> {
  return readFile(configPath, "utf8").catch(() => undefined);
}

function lastLine(text: string): { error: { code: string; message: string; status?: number } } {
  return JSON.parse(text.trim().split("\n").at(-1) as string);
}

describe("lazco auth login", () => {
  test("without a terminal and without --with-token it is CLI_INVALID_INPUT", async () => {
    const run = await runInProcess(["auth", "login", "--api-url", api.apiUrl], {
      env: cliEnv(home.home),
      stdin: FAKE_TOKEN,
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(lastLine(run.stderr).error.code).toBe("CLI_INVALID_INPUT");
    expect(api.requests).toHaveLength(0);
  });

  test("an admin key is refused before any request, and nothing is stored", async () => {
    const keychain = memoryKeychain();
    const adminKey = `lz_admin_${"0".repeat(48)}${"ab".repeat(8)}`;
    const run = await runInProcess(["auth", "login", "--with-token", "--api-url", api.apiUrl], {
      env: cliEnv(home.home),
      stdin: adminKey,
      keychain,
    });
    expect(run.code).toBe(1);
    expect(lastLine(run.stderr).error.code).toBe("CLI_INVALID_INPUT");
    expect(lastLine(run.stderr).error.message).toContain("admin key");
    expect(run.stderr).not.toContain(adminKey);
    expect(api.requests).toHaveLength(0);
    expect(keychain.entries.size).toBe(0);
    expect(await configText()).toBeUndefined();
  });

  test("a value of the wrong form is refused before any request", async () => {
    for (const value of [FAKE_TOKEN.toUpperCase(), `${FAKE_TOKEN}0`, "lz_live_abc", ""]) {
      const run = await runInProcess(["auth", "login", "--with-token", "--api-url", api.apiUrl], {
        env: cliEnv(home.home),
        stdin: value,
      });
      expect(lastLine(run.stderr).error.code).toBe("CLI_INVALID_INPUT");
    }
    expect(api.requests).toHaveLength(0);
  });

  test("a 401 passes through and stores nothing", async () => {
    const keychain = memoryKeychain();
    const revoked = `lz_live_${"0".repeat(48)}${"dead".repeat(4)}`;
    const run = await runInProcess(["auth", "login", "--with-token", "--api-url", api.apiUrl], {
      env: cliEnv(home.home),
      stdin: `${revoked}\n`,
      keychain,
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(lastLine(run.stderr).error).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(api.requests.map((request) => request.headers.authorization)).toEqual([
      `Bearer ${revoked}`,
    ]);
    expect(keychain.entries.size).toBe(0);
    expect(await configText()).toBeUndefined();
  });

  test("a 200 stores the token in the keychain and prints no part of it", async () => {
    const keychain = memoryKeychain();
    const run = await runInProcess(["auth", "login", "--with-token", "--api-url", api.apiUrl], {
      env: cliEnv(home.home),
      stdin: `${FAKE_TOKEN}\n`,
      keychain,
    });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      profile: "default",
      apiUrl: api.apiUrl,
      organization: { id: "org-1", name: "First Org" },
      store: "keychain",
      current: true,
    });
    expect(tokensOf(keychain, "default")).toEqual([FAKE_TOKEN]);
    for (const text of [run.stdout, run.stderr, (await configText()) as string]) {
      expect(text).not.toContain(FAKE_TOKEN);
      expect(text).not.toContain(FAKE_TOKEN.slice(-8));
    }
    expect(JSON.parse((await configText()) as string)).toEqual({
      version: 1,
      currentProfile: "default",
      profiles: {
        default: {
          apiUrl: api.apiUrl,
          organization: { id: "org-1", name: "First Org" },
          credential: {
            store: "keychain",
            account: expect.stringMatching(/^default@[0-9a-f]{16}$/),
          },
        },
      },
    });
  });

  test("a throwing keychain stores the token in the config file with mode 0600 and says so", async () => {
    const run = await runInProcess(["auth", "login", "--with-token", "--api-url", api.apiUrl], {
      env: cliEnv(home.home),
      stdin: FAKE_TOKEN,
      keychain: brokenKeychain(),
    });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ store: "file", path: configPath });
    expect(run.stderr).toContain("no keychain was found (no Secret Service is running)");
    expect(run.stderr).toContain(configPath);
    expect(run.stdout + run.stderr).not.toContain(FAKE_TOKEN.slice(-8));
    const config = JSON.parse((await configText()) as string);
    expect(config.profiles.default.credential).toEqual({ store: "file", token: FAKE_TOKEN });
    if (process.platform !== "win32") {
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("a second profile is not made current, and a new organization is said on stderr", async () => {
    const keychain = memoryKeychain();
    const env = cliEnv(home.home);
    const login = (profile: string, token: string) =>
      runInProcess(
        ["auth", "login", "--with-token", "--profile", profile, "--api-url", api.apiUrl],
        { env, stdin: token, keychain },
      );
    expect((await login("default", FAKE_TOKEN)).code).toBe(0);
    const second = await login("staging", OTHER_TOKEN);
    expect(JSON.parse(second.stdout)).toMatchObject({ profile: "staging", current: false });
    const again = await login("default", OTHER_TOKEN);
    expect(again.code).toBe(0);
    expect(again.stderr).toContain("profile default now signs in to Second Org, not First Org");
    expect(tokensOf(keychain, "default")).toEqual([OTHER_TOKEN]);
  });

  test.skipIf(process.platform === "win32")(
    "a config file that cannot be written keeps the old entry and drops the new one",
    async () => {
      const keychain = memoryKeychain();
      const otherApi = whoamiApi();
      const env = cliEnv(home.home);
      try {
        await runInProcess(["auth", "login", "--with-token", "--api-url", api.apiUrl], {
          env,
          stdin: FAKE_TOKEN,
          keychain,
        });
        await chmod(dirname(configPath), 0o500);
        const failed = await runInProcess(
          ["auth", "login", "--with-token", "--api-url", otherApi.apiUrl],
          { env, stdin: OTHER_TOKEN, keychain },
        );
        expect(failed.code).toBe(1);
        expect(tokensOf(keychain, "default")).toEqual([FAKE_TOKEN]);
        api.requests.length = 0;
        const status = await runInProcess(["auth", "status"], { env, keychain });
        expect(status.code).toBe(0);
        expect(api.requests.map((request) => request.headers.authorization)).toEqual([
          `Bearer ${FAKE_TOKEN}`,
        ]);
      } finally {
        await chmod(dirname(configPath), 0o700);
        otherApi.stop();
      }
    },
  );

  test("two config files with one profile name keep two keychain entries", async () => {
    const keychain = memoryKeychain();
    const otherApi = whoamiApi();
    try {
      const firstEnv = cliEnv(home.home);
      const secondEnv = cliEnv(home.home, { XDG_CONFIG_HOME: join(home.home, "second-config") });
      const first = await runInProcess(["auth", "login", "--with-token", "--api-url", api.apiUrl], {
        env: firstEnv,
        stdin: FAKE_TOKEN,
        keychain,
      });
      expect(first.code).toBe(0);
      const second = await runInProcess(
        ["auth", "login", "--with-token", "--api-url", otherApi.apiUrl],
        { env: secondEnv, stdin: OTHER_TOKEN, keychain },
      );
      expect(second.code).toBe(0);
      expect(tokensOf(keychain, "default").sort()).toEqual([FAKE_TOKEN, OTHER_TOKEN].sort());
      api.requests.length = 0;
      const status = await runInProcess(["auth", "status"], { env: firstEnv, keychain });
      expect(status.code).toBe(0);
      expect(api.requests.map((request) => request.headers.authorization)).toEqual([
        `Bearer ${FAKE_TOKEN}`,
      ]);
      const logout = await runInProcess(["auth", "logout"], { env: firstEnv, keychain });
      expect(logout.code).toBe(0);
      expect(tokensOf(keychain, "default")).toEqual([OTHER_TOKEN]);
      otherApi.requests.length = 0;
      const secondStatus = await runInProcess(["auth", "status"], { env: secondEnv, keychain });
      expect(secondStatus.code).toBe(0);
      expect(otherApi.requests.map((request) => request.headers.authorization)).toEqual([
        `Bearer ${OTHER_TOKEN}`,
      ]);
    } finally {
      otherApi.stop();
    }
  });

  test("an old entry that cannot be deleted is named on stderr, and the new login works", async () => {
    const memory = memoryKeychain();
    let refuseDeletes = false;
    const keychain = {
      ...memory,
      delete: async (account: string) => {
        if (refuseDeletes) throw new Error("the keychain is locked");
        return memory.delete(account);
      },
    };
    const env = cliEnv(home.home);
    const login = (token: string) =>
      runInProcess(["auth", "login", "--with-token", "--api-url", api.apiUrl], {
        env,
        stdin: token,
        keychain,
      });
    expect((await login(FAKE_TOKEN)).code).toBe(0);
    const [oldAccount] = [...memory.entries.keys()];
    refuseDeletes = true;
    const again = await login(OTHER_TOKEN);
    expect(again.code).toBe(0);
    expect(again.stderr).toContain(
      `the keychain entry ${oldAccount} of the previous login could not be deleted`,
    );
    expect(again.stderr).not.toContain(FAKE_TOKEN.slice(-8));
    expect(tokensOf(memory, "default").sort()).toEqual([FAKE_TOKEN, OTHER_TOKEN].sort());
  });

  test("logging in again without --api-url keeps the profile's own API URL", async () => {
    const keychain = memoryKeychain();
    const env = cliEnv(home.home);
    await runInProcess(["auth", "login", "--with-token", "--api-url", api.apiUrl], {
      env,
      stdin: FAKE_TOKEN,
      keychain,
    });
    const again = await runInProcess(["auth", "login", "--with-token"], {
      env,
      stdin: FAKE_TOKEN,
      keychain,
    });
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout).apiUrl).toBe(api.apiUrl);
  });

  test("a token is never taken as an argument", async () => {
    const run = await runInProcess(["auth", "login", FAKE_TOKEN, "--api-url", api.apiUrl], {
      env: cliEnv(home.home),
    });
    expect(lastLine(run.stderr).error.code).toBe("CLI_INVALID_INPUT");
    expect(run.stderr).not.toContain(FAKE_TOKEN.slice(-8));
    expect(api.requests).toHaveLength(0);
  });

  test("a script pipes the token with --with-token", async () => {
    const revoked = `lz_live_${"0".repeat(48)}${"dead".repeat(4)}`;
    const run = await runLazco(
      ["auth", "login", "--with-token", "--api-url", api.apiUrl],
      cliEnv(home.home),
      revoked,
    );
    expect(run.code).toBe(1);
    expect(lastLine(run.stderr).error.status).toBe(401);
    expect(api.requests.map((request) => request.headers.authorization)).toEqual([
      `Bearer ${revoked}`,
    ]);
  });

  test("on a terminal the token is asked for with the input hidden", async () => {
    const revoked = `lz_live_${"0".repeat(48)}${"dead".repeat(4)}`;
    const run = await runLazcoOnTerminal(
      ["auth", "login", "--api-url", api.apiUrl],
      cliEnv(home.home),
      [{ after: "Paste a Lazco API token (hidden): ", type: revoked }],
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("Paste a Lazco API token (hidden): ");
    expect(run.output).not.toContain(revoked);
    expect(run.output).not.toContain("dead");
    expect(run.output).toContain('"status":401');
    expect(api.requests.map((request) => request.headers.authorization)).toEqual([
      `Bearer ${revoked}`,
    ]);
    expect(await configText()).toBeUndefined();
  });
});
