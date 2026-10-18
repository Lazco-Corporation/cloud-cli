import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readConfig, updateConfig, writeConfig } from "../../src/config/configFile";
import { configFilePath } from "../../src/config/paths";
import { CliError } from "../../src/core/errors";
import { makeHome } from "../helpers/cli";

/** A complete SSO record, so a case fails only on the rule it is about. */
const VALID_SSO = {
  signInId: "0123456789abcdef",
  issuer: "https://cloud.lazco.tw",
  clientId: "lazco-cli",
  organizationId: "org-1",
  scope: "read",
  accessToken: "a",
  accessTokenExpiresAt: 1,
  refreshToken: "r",
};

let home: Awaited<ReturnType<typeof makeHome>>;
let path: string;

beforeEach(async () => {
  home = await makeHome();
  path = join(home.home, "config", "lazco", "config.json");
});

afterEach(async () => {
  await home.cleanup();
});

async function invalidInput(promise: Promise<unknown>): Promise<CliError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("CLI_INVALID_INPUT");
  return error as CliError;
}

describe("config file paths", () => {
  test("XDG_CONFIG_HOME, then ~/.config, then %APPDATA% on Windows", () => {
    expect(configFilePath({ env: { XDG_CONFIG_HOME: "/x" }, platform: "linux", home: "/h" })).toBe(
      "/x/lazco/config.json",
    );
    expect(configFilePath({ env: {}, platform: "darwin", home: "/h" })).toBe(
      "/h/.config/lazco/config.json",
    );
    expect(
      configFilePath({ env: { APPDATA: "/appdata" }, platform: "win32", home: "/h" }),
    ).toEndWith(join("lazco", "config.json"));
    expect(
      configFilePath({ env: { APPDATA: "/appdata" }, platform: "win32", home: "/h" }),
    ).toStartWith("/appdata");
  });
});

describe("the config file", () => {
  test("a missing file is an empty config", async () => {
    expect(await readConfig(path)).toEqual({ version: 1, profiles: {} });
  });

  test("a written file reads back and has mode 0600", async () => {
    const config = {
      version: 1 as const,
      currentProfile: "default",
      profiles: {
        default: {
          apiUrl: "https://api.lazco.tw/v1",
          organization: { id: "org-1", name: "Org" },
          method: "token" as const,
          credential: { store: "keychain" as const, account: "default@0123456789abcdef" },
        },
      },
    };
    await writeConfig(path, config);
    expect(await readConfig(path)).toEqual(config);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    }
  });

  test("a file that is not JSON is CLI_INVALID_INPUT naming it", async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ not json");
    const error = await invalidInput(readConfig(path));
    expect(error.message).toContain(path);
    expect(error.details).toEqual([{ field: path, message: "is not valid JSON" }]);
  });

  test("a file that fails the schema is CLI_INVALID_INPUT naming it and the field", async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profiles: { default: { apiUrl: "https://api.lazco.tw/v1", credential: { store: "disk" } } },
      }),
    );
    const error = await invalidInput(readConfig(path));
    expect(error.message).toContain(path);
    expect(error.message).toContain("profiles.default");
  });

  test("a current profile that does not exist is CLI_INVALID_INPUT", async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, currentProfile: "gone", profiles: {} }));
    const error = await invalidInput(readConfig(path));
    expect(error.message).toContain("currentProfile");
  });

  test("a keychain account of another profile is CLI_INVALID_INPUT", async () => {
    await mkdir(dirname(path), { recursive: true });
    const organization = { id: "org-1", name: "Org" };
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profiles: {
          staging: {
            apiUrl: "https://api-staging.lazco.tw/v1",
            organization,
            method: "token",
            credential: { store: "keychain", account: "default@0123456789abcdef" },
          },
        },
      }),
    );
    const error = await invalidInput(readConfig(path));
    expect(error.message).toContain("another profile");
  });

  test("a profile without its sign-in method is CLI_INVALID_INPUT", async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profiles: {
          default: {
            apiUrl: "https://api.lazco.tw/v1",
            organization: { id: "org-1", name: "Org" },
            credential: { store: "file", token: "t" },
          },
        },
      }),
    );
    const error = await invalidInput(readConfig(path));
    expect(error.message).toContain("profiles.default.method");
  });

  for (const [label, method, credential] of [
    ["a token profile with an SSO sign-in", "token", { store: "file", sso: VALID_SSO }],
    ["an SSO profile with a token too", "sso", { store: "file", sso: VALID_SSO, token: "t" }],
    ["an SSO profile with a token", "sso", { store: "file", token: "t" }],
    ["a file credential with nothing", "token", { store: "file" }],
  ] as const) {
    test(`${label} in the file store is CLI_INVALID_INPUT`, async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          profiles: {
            default: {
              apiUrl: "https://api.lazco.tw/v1",
              organization: { id: "org-1", name: "Org" },
              method,
              credential,
            },
          },
        }),
      );
      const error = await invalidInput(readConfig(path));
      expect(error.message).toContain("profiles.default.credential");
    });
  }

  test("a field of a credential that this version does not know is kept", async () => {
    const config = {
      version: 1 as const,
      profiles: {
        default: {
          apiUrl: "https://api.lazco.tw/v1",
          organization: { id: "org-1", name: "Org" },
          method: "token" as const,
          credential: {
            store: "keychain" as const,
            account: "default@0123456789abcdef",
            later: true,
          },
        },
      },
    };
    await writeConfig(path, config);
    expect(await readConfig(path)).toEqual(config);
  });

  test("updates at once never lose one another's write", async () => {
    const names = Array.from({ length: 8 }, (_, index) => `p${index}`);
    await Promise.all(
      names.map((name) =>
        updateConfig(path, async (config) => {
          // A slow change, so every update reads the file before the others write.
          await Bun.sleep(5);
          config.profiles[name] = {
            apiUrl: "https://api.lazco.tw/v1",
            organization: { id: "org-1", name: "Org" },
            method: "token",
            credential: { store: "file", token: name },
          };
        }),
      ),
    );
    expect(Object.keys((await readConfig(path)).profiles).sort()).toEqual(names);
  });

  test("an update whose change throws writes nothing", async () => {
    const failed = await updateConfig(path, (config) => {
      config.currentProfile = "x";
      throw new Error("no");
    }).catch((error: unknown) => error);
    expect((failed as Error).message).toBe("no");
    expect(await readConfig(path)).toEqual({ version: 1, profiles: {} });
  });

  test("an unknown version is CLI_INVALID_INPUT", async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 2, profiles: {} }));
    await invalidInput(readConfig(path));
  });
});
