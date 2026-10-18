import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeConfig } from "../../src/config/configFile";
import { cliEnv, FAKE_TOKEN, makeHome, runInProcess } from "../helpers/cli";
import type { FakeApi } from "../helpers/fakeApi";
import { fixtureApi, operationRequests } from "../helpers/fixtureApi";
import { accountOf, memoryKeychain } from "../helpers/keychain";

const tokenOf = (suffix: string) => `lz_live_${"0".repeat(48)}${suffix.repeat(16 / suffix.length)}`;
const DEFAULT_TOKEN = tokenOf("d0");
const STAGING_TOKEN = tokenOf("5a");
const FILE_TOKEN = tokenOf("f1");

let api: FakeApi;
let otherApi: FakeApi;
let home: Awaited<ReturnType<typeof makeHome>>;
let keychain: ReturnType<typeof memoryKeychain>;

beforeEach(async () => {
  api = fixtureApi();
  otherApi = fixtureApi();
  home = await makeHome();
  keychain = memoryKeychain();
  keychain.entries.set(accountOf("default"), DEFAULT_TOKEN);
  keychain.entries.set(accountOf("staging"), STAGING_TOKEN);
  const organization = { id: "org-1", name: "Fixture Org" };
  await writeConfig(join(home.home, "config", "lazco", "config.json"), {
    version: 1,
    currentProfile: "default",
    profiles: {
      default: {
        apiUrl: api.apiUrl,
        organization,
        method: "token",
        credential: { store: "keychain", account: accountOf("default") },
      },
      staging: {
        apiUrl: api.apiUrl,
        organization,
        method: "token",
        credential: { store: "keychain", account: accountOf("staging") },
      },
      plain: {
        apiUrl: api.apiUrl,
        organization,
        method: "token",
        credential: { store: "file", token: FILE_TOKEN },
      },
      remote: {
        apiUrl: otherApi.apiUrl,
        organization,
        method: "token",
        credential: { store: "keychain", account: accountOf("remote") },
      },
    },
  });
  keychain.entries.set(accountOf("remote"), tokenOf("ee"));
});

afterEach(async () => {
  api.stop();
  otherApi.stop();
  await home.cleanup();
});

function run(args: readonly string[], extra: Record<string, string> = {}) {
  return runInProcess(args, { env: cliEnv(home.home, extra), keychain });
}

/** The credential of each request that was not for the spec. */
function credentialsSent(target: FakeApi): Array<string | undefined> {
  return target.requests
    .filter((request) => request.path !== "/v1/spec")
    .map((request) => request.headers.authorization);
}

function errorOf(stderr: string): { code: string; message: string } {
  return JSON.parse(stderr.trim().split("\n").at(-1) as string).error;
}

describe("the credential order", () => {
  test("LAZCO_TOKEN wins over --profile, and goes to --api-url", async () => {
    const result = await run(["--api-url", api.apiUrl, "--profile", "staging", "regions", "list"], {
      LAZCO_TOKEN: FAKE_TOKEN,
    });
    expect(result.code).toBe(0);
    expect(credentialsSent(api)).toEqual([`Bearer ${FAKE_TOKEN}`]);
  });

  test("--profile wins over LAZCO_PROFILE", async () => {
    const result = await run(["--profile", "staging", "regions", "list"], {
      LAZCO_PROFILE: "plain",
    });
    expect(result.code).toBe(0);
    expect(credentialsSent(api)).toEqual([`Bearer ${STAGING_TOKEN}`]);
  });

  test("LAZCO_PROFILE wins over the current profile, and a file store works", async () => {
    const result = await run(["regions", "list"], { LAZCO_PROFILE: "plain" });
    expect(result.code).toBe(0);
    expect(credentialsSent(api)).toEqual([`Bearer ${FILE_TOKEN}`]);
  });

  test("the current profile is used last, at its own API URL", async () => {
    const result = await run(["regions", "list"]);
    expect(result.code).toBe(0);
    expect(credentialsSent(api)).toEqual([`Bearer ${DEFAULT_TOKEN}`]);
    expect(otherApi.requests).toHaveLength(0);
  });

  test("a profile at another API is reached without --api-url", async () => {
    const result = await run(["--profile", "remote", "regions", "list"]);
    expect(result.code).toBe(0);
    expect(credentialsSent(otherApi)).toEqual([`Bearer ${tokenOf("ee")}`]);
    expect(api.requests).toHaveLength(0);
  });

  test("a named profile that does not exist is CLI_INVALID_INPUT", async () => {
    for (const [args, extra] of [
      [["--profile", "nope", "regions", "list"], {}],
      [["regions", "list"], { LAZCO_PROFILE: "nope" }],
    ] as const) {
      const result = await run(args, extra);
      expect(result.code).toBe(1);
      expect(errorOf(result.stderr).code).toBe("CLI_INVALID_INPUT");
    }
    expect(api.requests).toHaveLength(0);
  });

  test("an invalid profile name is CLI_INVALID_INPUT", async () => {
    const result = await run(["--profile", "../x", "regions", "list"]);
    expect(errorOf(result.stderr).code).toBe("CLI_INVALID_INPUT");
  });
});

describe("a stored credential is bound to its API URL", () => {
  test("--api-url to another API is CLI_INVALID_INPUT and the token is not sent", async () => {
    const result = await run(["--api-url", otherApi.apiUrl, "compute", "get", "srv-1"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const error = errorOf(result.stderr);
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.message).toContain(api.apiUrl);
    expect(otherApi.requests.every((request) => request.headers.authorization === undefined)).toBe(
      true,
    );
    expect(operationRequests(otherApi.requests)).toEqual([]);
    expect(api.requests).toHaveLength(0);
  });

  test("the same URL given with --api-url is fine", async () => {
    const result = await run(["--api-url", api.apiUrl, "regions", "list"]);
    expect(result.code).toBe(0);
    expect(credentialsSent(api)).toEqual([`Bearer ${DEFAULT_TOKEN}`]);
  });

  test("--describe at another API hides nothing and sends no credential", async () => {
    const result = await run(["--api-url", otherApi.apiUrl, "--describe"]);
    expect(result.code).toBe(0);
    expect(otherApi.requests.map((request) => request.path)).toEqual(["/v1/spec"]);
    expect(otherApi.requests[0]?.headers.authorization).toBeUndefined();
  });

  test("LAZCO_TOKEN may go to any --api-url", async () => {
    const result = await run(["--api-url", otherApi.apiUrl, "regions", "list"], {
      LAZCO_TOKEN: FAKE_TOKEN,
    });
    expect(result.code).toBe(0);
    expect(credentialsSent(otherApi)).toEqual([`Bearer ${FAKE_TOKEN}`]);
  });
});

describe("no credential", () => {
  test("no profile and no LAZCO_TOKEN is CLI_NOT_LOGGED_IN", async () => {
    const empty = await makeHome();
    try {
      const result = await runInProcess(["--api-url", api.apiUrl, "regions", "list"], {
        env: cliEnv(empty.home),
        keychain,
      });
      expect(result.code).toBe(1);
      const error = errorOf(result.stderr);
      expect(error.code).toBe("CLI_NOT_LOGGED_IN");
      expect(error.message).toContain("lazco auth login");
      expect(operationRequests(api.requests)).toEqual([]);
    } finally {
      await empty.cleanup();
    }
  });

  test("a keychain that lost the entry is CLI_NOT_LOGGED_IN naming the profile", async () => {
    keychain.entries.delete(accountOf("default"));
    const result = await run(["regions", "list"]);
    const error = errorOf(result.stderr);
    expect(error.code).toBe("CLI_NOT_LOGGED_IN");
    expect(error.message).toContain("--profile default");
  });
});
