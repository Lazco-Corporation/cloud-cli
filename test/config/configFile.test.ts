import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readConfig, writeConfig } from "../../src/config/configFile";
import { configFilePath } from "../../src/config/paths";
import { CliError } from "../../src/core/errors";
import { makeHome } from "../helpers/cli";

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
            credential: { store: "keychain", account: "default@0123456789abcdef" },
          },
        },
      }),
    );
    const error = await invalidInput(readConfig(path));
    expect(error.message).toContain("another profile");
  });

  test("a field of a credential that this version does not know is kept", async () => {
    const config = {
      version: 1 as const,
      profiles: {
        default: {
          apiUrl: "https://api.lazco.tw/v1",
          organization: { id: "org-1", name: "Org" },
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

  test("an unknown version is CLI_INVALID_INPUT", async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 2, profiles: {} }));
    await invalidInput(readConfig(path));
  });
});
