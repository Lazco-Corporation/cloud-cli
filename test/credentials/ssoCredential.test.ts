import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ApiClient } from "../../src/core/request/client";
import { RateLimiter } from "../../src/core/request/rateLimiter";
import { SsoCredential } from "../../src/credentials/ssoCredential";
import type { SsoRecord } from "../../src/credentials/ssoRecord";
import { makeHome } from "../helpers/cli";
import { FakeProvider } from "../helpers/fakeProvider";
import { memoryKeychain } from "../helpers/keychain";

let provider: FakeProvider;
let home: Awaited<ReturnType<typeof makeHome>>;
let configPath: string;

beforeEach(async () => {
  provider = new FakeProvider();
  home = await makeHome();
  configPath = join(home.home, "config", "lazco", "config.json");
});

afterEach(async () => {
  provider.stop();
  await home.cleanup();
});

function credentialOf(record: SsoRecord): SsoCredential {
  const limiter = new RateLimiter();
  return new SsoCredential({
    profileName: "default",
    configPath,
    keychain: memoryKeychain(),
    apiUrl: provider.apiUrl,
    record,
    client: (url) => new ApiClient({ apiUrl: url, userAgent: "lazco-test", limiter }),
    onSecret: () => undefined,
  });
}

describe("calls of one process", () => {
  test("three calls while one refresh runs make one refresh request and share its pair", async () => {
    provider.refreshDelayMs = 200;
    const record = provider.record({ lifetimeSeconds: 30 });
    await provider.seedFileProfile(configPath, "default", record);
    const credential = credentialOf(record);
    const bearers = await Promise.all([
      credential.bearer(),
      credential.bearer(),
      credential.bearer(),
    ]);
    expect(provider.requestsTo("/oidc/token", "refresh_token")).toHaveLength(1);
    expect(new Set(bearers).size).toBe(1);
    expect(bearers[0]).not.toBe(record.accessToken);
  });

  test("calls that wait on a refresh that ends the sign-in get its error, and send nothing more", async () => {
    provider.refreshDelayMs = 200;
    const record = provider.record({ lifetimeSeconds: 30 });
    (provider.families[0] as { revoked: boolean }).revoked = true;
    await provider.seedFileProfile(configPath, "default", record);
    const credential = credentialOf(record);
    const outcomes = await Promise.allSettled([
      credential.bearer(),
      credential.bearer(),
      credential.bearer(),
    ]);
    expect(provider.requestsTo("/oidc/token", "refresh_token")).toHaveLength(1);
    const messages = outcomes.map((outcome) =>
      outcome.status === "rejected" ? (outcome.reason as Error).message : "fulfilled",
    );
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toContain("has ended");
  });
});
