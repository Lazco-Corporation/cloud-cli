import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeConfig } from "../../src/config/configFile";
import type { CliError } from "../../src/core/errors";
import { profileLockPath, withProfileLock } from "../../src/credentials/lock";
import type { SsoRecord } from "../../src/credentials/ssoRecord";
import { cliEnv, makeHome, runLazco } from "../helpers/cli";
import { FakeProvider } from "../helpers/fakeProvider";

let home: Awaited<ReturnType<typeof makeHome>>;
let configPath: string;

beforeEach(async () => {
  home = await makeHome();
  configPath = join(home.home, "config", "lazco", "config.json");
});

afterEach(async () => {
  await home.cleanup();
});

describe("the profile lock", () => {
  test("sits beside the config file, one per profile", () => {
    expect(profileLockPath("/c/lazco/config.json", "staging")).toBe(
      join("/c/lazco", "locks", "staging.lock"),
    );
  });

  test("a second holder waits for the first, and gives up with CLI_TIMEOUT", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = withProfileLock({ configPath, profileName: "default" }, async () => {
      order.push("first in");
      entered();
      await held;
      order.push("first out");
    });
    await inside;
    const impatient = (await withProfileLock(
      { configPath, profileName: "default", waitMs: 200 },
      async () => order.push("impatient in"),
    ).catch((thrown: unknown) => thrown)) as CliError;
    expect(impatient.code).toBe("CLI_TIMEOUT");
    const second = withProfileLock({ configPath, profileName: "default" }, async () => {
      order.push("second in");
    });
    // The second holder polls every 100 ms, and must still be out after a few polls.
    await Bun.sleep(250);
    expect(order).toEqual(["first in"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first in", "first out", "second in"]);
  });

  test("another profile's lock does not wait", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = withProfileLock({ configPath, profileName: "a" }, () => {
      entered();
      return held;
    });
    await inside;
    await withProfileLock({ configPath, profileName: "b", waitMs: 200 }, async () => undefined);
    release();
    await first;
  });
});

describe("two processes of two file-store profiles", () => {
  test("both refreshed pairs stay in the one config file", async () => {
    const provider = new FakeProvider();
    try {
      provider.refreshDelayMs = 300;
      const first = provider.record({ lifetimeSeconds: 30 });
      const second = provider.record({ lifetimeSeconds: 30 });
      const profileOf = (sso: SsoRecord) => ({
        apiUrl: provider.apiUrl,
        organization: { id: sso.organizationId, name: "Org A" },
        method: "sso" as const,
        credential: { store: "file" as const, sso },
      });
      await writeConfig(configPath, {
        version: 1,
        profiles: { a: profileOf(first), b: profileOf(second) },
      });
      const env = cliEnv(home.home);
      const runs = await Promise.all([
        runLazco(["--profile", "a", "auth", "status"], env),
        runLazco(["--profile", "b", "auth", "status"], env),
      ]);
      expect(runs.map((run) => run.code)).toEqual([0, 0]);
      expect(provider.requestsTo("/oidc/token", "refresh_token")).toHaveLength(2);
      const profiles = JSON.parse(await readFile(configPath, "utf8")).profiles;
      expect(profiles.a.credential.sso.refreshToken).not.toBe(first.refreshToken);
      expect(profiles.b.credential.sso.refreshToken).not.toBe(second.refreshToken);
    } finally {
      provider.stop();
    }
  }, 30_000);
});

describe("two processes of one profile", () => {
  test("make one refresh request between them, and both succeed", async () => {
    const provider = new FakeProvider();
    try {
      provider.refreshDelayMs = 700;
      const record = provider.record({ lifetimeSeconds: 30 });
      await provider.seedFileProfile(configPath, "default", record);
      const env = cliEnv(home.home);
      const [first, second] = await Promise.all([
        runLazco(["auth", "status"], env),
        runLazco(["auth", "status"], env),
      ]);
      expect([first.code, second.code]).toEqual([0, 0]);
      expect(provider.requestsTo("/oidc/token", "refresh_token")).toHaveLength(1);
      const stored = JSON.parse(await readFile(configPath, "utf8")).profiles.default.credential
        .sso as SsoRecord;
      expect(stored.refreshToken).not.toBe(record.refreshToken);
      expect(
        provider.requestsTo("/whoami").map((request) => request.headers.authorization),
      ).toEqual([`Bearer ${stored.accessToken}`, `Bearer ${stored.accessToken}`]);
    } finally {
      provider.stop();
    }
  }, 30_000);
});
