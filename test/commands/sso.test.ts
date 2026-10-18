import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type Config, writeConfig } from "../../src/config/configFile";
import type { SsoRecord } from "../../src/credentials/ssoRecord";
import { CLI_PATH, type CliRun, cliEnv, FAKE_TOKEN, makeHome, runInProcess } from "../helpers/cli";
import { closedApiUrl, fakeClock, json } from "../helpers/fakeApi";
import { FakeProvider } from "../helpers/fakeProvider";
import { fixtureApi } from "../helpers/fixtureApi";
import { accountOf, memoryKeychain, tokensOf } from "../helpers/keychain";

let provider: FakeProvider;
let home: Awaited<ReturnType<typeof makeHome>>;
let configPath: string;
let keychain: ReturnType<typeof memoryKeychain>;
const outputs: CliRun[] = [];

beforeEach(async () => {
  provider = new FakeProvider();
  home = await makeHome();
  configPath = join(home.home, "config", "lazco", "config.json");
  keychain = memoryKeychain();
  outputs.length = 0;
});

afterEach(async () => {
  try {
    // No command of any test printed any part of a token the provider issued.
    for (const run of outputs) {
      for (const token of [...provider.issuedTokens(), "device-code-secret"]) {
        for (const text of [run.stdout, run.stderr]) {
          if (text.includes(token) || text.includes(token.slice(-8))) {
            throw new Error(`a token reached the output: ${text}`);
          }
        }
      }
    }
  } finally {
    provider.stop();
    await home.cleanup();
  }
});

async function lazco(
  args: readonly string[],
  options: {
    env?: Record<string, string>;
    clock?: ReturnType<typeof fakeClock>;
    loopbackTimeoutMs?: number;
    openBrowser?: (url: string) => Promise<boolean>;
    stdin?: string;
  } = {},
): Promise<CliRun> {
  const run = await runInProcess(args, {
    env: cliEnv(home.home, options.env),
    keychain,
    clock: options.clock,
    loopbackTimeoutMs: options.loopbackTimeoutMs,
    openBrowser: options.openBrowser ?? provider.openBrowser,
    stdin: options.stdin,
    // A desktop, so the loopback flow runs unless a test asks for the device flow.
    platform: "darwin",
  });
  outputs.push(run);
  return run;
}

function errorOf(run: CliRun): {
  code: string;
  message: string;
  details?: { oauthError?: string };
} {
  return JSON.parse(run.stderr.trim().split("\n").at(-1) as string).error;
}

async function storedConfig(): Promise<Config> {
  return JSON.parse(await readFile(configPath, "utf8"));
}

function storedRecord(profile = "default"): SsoRecord {
  const [text] = tokensOf(keychain, profile);
  return JSON.parse(text as string);
}

/** A config whose profile holds an SSO record in the keychain. */
async function seedKeychainProfile(record: SsoRecord, profile = "default"): Promise<void> {
  keychain.entries.set(accountOf(profile), JSON.stringify(record));
  await writeConfig(configPath, {
    version: 1,
    currentProfile: profile,
    profiles: {
      [profile]: {
        apiUrl: provider.apiUrl,
        organization: { id: record.organizationId, name: "Org A" },
        method: "sso",
        credential: { store: "keychain", account: accountOf(profile) },
      },
    },
  });
}

const login = (...flags: string[]) => ["auth", "login", "--api-url", provider.apiUrl, ...flags];

describe("lazco auth login --sso, loopback", () => {
  test("a browser on this machine signs in, and the sign-in is checked and stored", async () => {
    const run = await lazco(login("--sso"));
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      profile: "default",
      method: "sso",
      apiUrl: provider.apiUrl,
      organization: { id: "org-a", name: "Org A" },
      scope: "read_write",
      store: "keychain",
      current: true,
    });

    const [authorize] = provider.authorizeUrls;
    const query = Object.fromEntries((authorize as URL).searchParams);
    expect(query).toMatchObject({
      response_type: "code",
      client_id: "lazco-cli",
      scope: "openid lazco.read lazco.write",
      code_challenge_method: "S256",
    });
    expect(query.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(query.state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(query.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(query.organization_hint).toBeUndefined();
    expect(run.stderr).toContain("opening your browser");

    const [exchange] = provider.requestsTo("/oidc/token", "authorization_code");
    const form = exchange?.body as Record<string, string>;
    expect(form.redirect_uri).toBe(query.redirect_uri);
    expect(form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.device_name).toContain("(macOS)");
    expect(form.client_secret).toBeUndefined();
    expect(exchange?.headers.authorization).toBeUndefined();

    const record = storedRecord();
    expect(record).toMatchObject({
      issuer: provider.issuer,
      clientId: "lazco-cli",
      organizationId: "org-a",
      scope: "read_write",
    });
    expect(provider.isAccessToken(record.accessToken)).toBe(true);
    const config = await storedConfig();
    expect(config.profiles.default).toMatchObject({
      method: "sso",
      credential: { store: "keychain" },
    });
    const configText = JSON.stringify(config);
    expect(configText).not.toContain(record.accessToken);
    expect(configText).not.toContain(record.refreshToken);
    expect(provider.requestsTo("/whoami").map((request) => request.headers.authorization)).toEqual([
      `Bearer ${record.accessToken}`,
    ]);
  });

  test("--read-only asks for read only, and the stored scope is read", async () => {
    const run = await lazco(login("--sso", "--read-only"));
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).scope).toBe("read");
    expect(provider.authorizeUrls[0]?.searchParams.get("scope")).toBe("openid lazco.read");
    expect(storedRecord().scope).toBe("read");
  });

  test("a cancel in the browser is CLI_NOT_LOGGED_IN with oauthError, and nothing is stored", async () => {
    provider.browser = "deny";
    const run = await lazco(login("--sso"));
    expect(run.code).toBe(1);
    expect(errorOf(run)).toMatchObject({
      code: "CLI_NOT_LOGGED_IN",
      details: { oauthError: "access_denied" },
    });
    expect(provider.requestsTo("/oidc/token")).toHaveLength(0);
    expect(keychain.entries.size).toBe(0);
  });

  for (const [label, choice] of [
    ["a forged state", "forge-state"],
    ["a wrong iss", "wrong-iss"],
    ["a missing iss", "no-iss"],
  ] as const) {
    test(`${label} is CLI_BAD_RESPONSE, and the code is never exchanged`, async () => {
      provider.browser = choice;
      const run = await lazco(login("--sso"));
      expect(run.code).toBe(1);
      expect(errorOf(run).code).toBe("CLI_BAD_RESPONSE");
      expect(provider.requestsTo("/oidc/token")).toHaveLength(0);
      expect(keychain.entries.size).toBe(0);
    });
  }

  test("no callback in time is CLI_TIMEOUT", async () => {
    provider.browser = "never-return";
    const run = await lazco(login("--sso"), { loopbackTimeoutMs: 200 });
    expect(run.code).toBe(1);
    expect(errorOf(run).code).toBe("CLI_TIMEOUT");
    expect(provider.requestsTo("/oidc/token")).toHaveLength(0);
  });

  test.skipIf(process.platform === "win32")(
    "a sign-in that cannot be stored is revoked",
    async () => {
      await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
      await chmod(dirname(configPath), 0o500);
      try {
        const run = await lazco(login("--sso"));
        expect(run.code).toBe(1);
        expect(provider.requestsTo("/oidc/revoke")).toHaveLength(1);
        expect(provider.families[0]?.revoked).toBe(true);
      } finally {
        await chmod(dirname(configPath), 0o700);
      }
    },
  );

  test("an API error of an OAuth endpoint passes through with its code", async () => {
    const original = provider.api.handler;
    provider.api.handler = (request) =>
      request.path === "/v1/oidc/device_authorization"
        ? json(429, { error: "Too many requests", code: "RATE_LIMITED", timestamp: "t" })
        : original(request);
    const run = await lazco(login("--device"), { clock: fakeClock(Date.now()) });
    expect(errorOf(run)).toMatchObject({ code: "RATE_LIMITED", status: 429 });
  });

  test("the URL is printed on stderr when no browser opens", async () => {
    provider.browser = "never-return";
    const run = await lazco(login("--sso"), {
      loopbackTimeoutMs: 200,
      openBrowser: async () => false,
    });
    expect(run.stderr).toContain(`${provider.api.origin}/oauth/authorize?`);
  });

  test("a sign-in that whoami refuses stores nothing and is revoked", async () => {
    // The member was removed between the consent and the first request.
    provider.refuseWhoami = true;
    const run = await lazco(login("--sso"));
    expect(run.code).toBe(1);
    expect(errorOf(run).code).toBe("ORG_ACCESS_DENIED");
    expect(keychain.entries.size).toBe(0);
    expect(provider.requestsTo("/oidc/revoke")).toHaveLength(1);
  });
});

describe("lazco auth login --sso, device", () => {
  test("SSH_CONNECTION picks the device flow, which polls through pending and slow_down", async () => {
    provider.deviceAnswers = [
      "authorization_pending",
      "slow_down",
      "authorization_pending",
      "approve",
    ];
    const clock = fakeClock(Date.now());
    let opened = 0;
    const run = await lazco(login("--sso", "--org", "org-b"), {
      env: { SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" },
      clock,
      openBrowser: async () => {
        opened += 1;
        return true;
      },
    });
    expect(run.code).toBe(0);
    expect(opened).toBe(0);
    expect(run.stderr).toContain(`${provider.issuer}/device`);
    expect(run.stderr).toContain("BCDF-GHJK");
    expect(run.stderr).toContain("enter this code only on that page");
    expect(clock.sleeps.filter((ms) => ms >= 5000)).toEqual([5000, 5000, 10_000, 10_000]);
    const [start] = provider.requestsTo("/oidc/device_authorization");
    expect(start?.body).toMatchObject({
      client_id: "lazco-cli",
      scope: "openid lazco.read lazco.write",
      organization_hint: "org-b",
    });
    expect((start?.body as Record<string, string> | undefined)?.device_name).toContain("(macOS)");
    expect(JSON.parse(run.stdout)).toMatchObject({
      method: "sso",
      organization: { id: "org-b", name: "Org B" },
    });
  });

  test("a denial is CLI_NOT_LOGGED_IN with oauthError access_denied", async () => {
    provider.deviceAnswers = ["authorization_pending", "access_denied"];
    const run = await lazco(login("--device"), { clock: fakeClock(Date.now()) });
    expect(errorOf(run)).toMatchObject({
      code: "CLI_NOT_LOGGED_IN",
      details: { oauthError: "access_denied" },
    });
    expect(keychain.entries.size).toBe(0);
  });

  test("a 429 on one poll skips that poll, and the sign-in goes on", async () => {
    provider.deviceAnswers = ["authorization_pending", "rate-limited", "approve"];
    const run = await lazco(login("--device"), { clock: fakeClock(Date.now()) });
    expect(run.code).toBe(0);
    expect(provider.requestsTo("/oidc/token")).toHaveLength(3);
  });

  test("a code never entered ends at its own expiry with CLI_TIMEOUT", async () => {
    provider.deviceAnswers = ["pending-forever"];
    const clock = fakeClock(Date.now());
    const run = await lazco(login("--device"), { clock });
    expect(errorOf(run)).toMatchObject({
      code: "CLI_TIMEOUT",
      details: { oauthError: "expired_token" },
    });
    // 600 seconds at 5 seconds a poll, and no poll after the expiry.
    expect(provider.requestsTo("/oidc/token")).toHaveLength(120);
  });

  test("an expired code is CLI_TIMEOUT", async () => {
    provider.deviceAnswers = ["authorization_pending", "expired_token"];
    const run = await lazco(login("--device"), { clock: fakeClock(Date.now()) });
    expect(errorOf(run).code).toBe("CLI_TIMEOUT");
    expect(keychain.entries.size).toBe(0);
  });

  test("a Linux host without a display picks the device flow", async () => {
    const run = await runInProcess(login("--sso"), {
      env: cliEnv(home.home),
      keychain,
      clock: fakeClock(Date.now()),
      platform: "linux",
      openBrowser: provider.openBrowser,
    });
    outputs.push(run);
    expect(run.code).toBe(0);
    expect(provider.authorizeUrls).toHaveLength(0);
    expect(provider.requestsTo("/oidc/device_authorization")).toHaveLength(1);
  });
});

describe("refresh", () => {
  test("an access token that expires within 60 seconds is refreshed before the request", async () => {
    const record = provider.record({ lifetimeSeconds: 30 });
    await seedKeychainProfile(record);
    const run = await lazco(["auth", "status"]);
    expect(run.code).toBe(0);
    expect(provider.requestsTo("/oidc/token", "refresh_token")).toHaveLength(1);
    const refreshed = storedRecord();
    expect(refreshed.refreshToken).not.toBe(record.refreshToken);
    expect(refreshed.signInId).toBe(record.signInId);
    expect(provider.requestsTo("/whoami").map((request) => request.headers.authorization)).toEqual([
      `Bearer ${refreshed.accessToken}`,
    ]);
  });

  test("a 401 refreshes once and sends the request once more", async () => {
    const record = provider.record({});
    provider.rejectedAccessTokens.add(record.accessToken);
    await seedKeychainProfile(record);
    const run = await lazco(["auth", "status"]);
    expect(run.code).toBe(0);
    expect(provider.requestsTo("/oidc/token", "refresh_token")).toHaveLength(1);
    expect(provider.requestsTo("/whoami")).toHaveLength(2);
  });

  test("a file-store sign-in is refreshed in the file", async () => {
    const record = provider.record({ lifetimeSeconds: 30 });
    await provider.seedFileProfile(configPath, "default", record);
    const run = await lazco(["auth", "status"]);
    expect(run.code).toBe(0);
    const stored = (await storedConfig()).profiles.default?.credential as { sso: SsoRecord };
    expect(stored.sso.refreshToken).not.toBe(record.refreshToken);
  });

  test("invalid_grant deletes the credential and the profile, and is CLI_NOT_LOGGED_IN", async () => {
    const record = provider.record({ lifetimeSeconds: 30 });
    (provider.families[0] as { revoked: boolean }).revoked = true;
    await seedKeychainProfile(record);
    const run = await lazco(["auth", "status"]);
    expect(run.code).toBe(1);
    expect(errorOf(run).code).toBe("CLI_NOT_LOGGED_IN");
    expect(errorOf(run).message).toContain("lazco auth login --sso --profile default");
    expect(keychain.entries.size).toBe(0);
    expect((await storedConfig()).profiles).toEqual({});
  });

  test("a refresh that cannot reach the API is CLI_NETWORK and keeps the credential", async () => {
    const record = provider.record({ lifetimeSeconds: 30 });
    await seedKeychainProfile(record);
    const config = await storedConfig();
    (config.profiles.default as { apiUrl: string }).apiUrl = await closedApiUrl();
    await writeConfig(configPath, config);
    const run = await lazco(["auth", "status"]);
    expect(errorOf(run).code).toBe("CLI_NETWORK");
    expect(storedRecord()).toEqual(record);
  });

  test("an error that echoes the refreshed access token prints it redacted", async () => {
    const fixture = fixtureApi();
    provider.fallback = (request) =>
      request.path === "/v1/spec"
        ? fixture.handler(request)
        : json(400, {
            error: `rejected ${request.headers.authorization}`,
            code: "ECHO",
            timestamp: "t",
          });
    try {
      await seedKeychainProfile(provider.record({ lifetimeSeconds: 30 }));
      const run = await lazco(["regions", "list"]);
      expect(run.code).toBe(1);
      expect(errorOf(run).code).toBe("ECHO");
      expect(run.stderr).toContain("[REDACTED]");
      expect(provider.requestsTo("/oidc/token", "refresh_token")).toHaveLength(1);
    } finally {
      fixture.stop();
    }
  });

  test("lazco mcp refreshes the sign-in it shares with the CLI", async () => {
    const fixture = fixtureApi();
    provider.fallback = (request) => fixture.handler(request);
    const record = provider.record({ lifetimeSeconds: 30 });
    await provider.seedFileProfile(configPath, "default", record);
    const transport = new StdioClientTransport({
      command: "bun",
      args: [CLI_PATH, "mcp"],
      env: cliEnv(home.home),
      stderr: "pipe",
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);
      expect(provider.requestsTo("/oidc/token", "refresh_token")).toHaveLength(1);
      const stored = (await storedConfig()).profiles.default?.credential as { sso: SsoRecord };
      expect(provider.requestsTo("/whoami").at(-1)?.headers.authorization).toBe(
        `Bearer ${stored.sso.accessToken}`,
      );
    } finally {
      await client.close();
      fixture.stop();
    }
  }, 30_000);
});

describe("sign-in options and logout", () => {
  test("a new sign-in on an SSO profile hints its organization and revokes the old one", async () => {
    const first = await lazco(login("--sso", "--org", "org-b"));
    expect(first.code).toBe(0);
    const old = storedRecord();
    const again = await lazco(login("--sso"));
    expect(again.code).toBe(0);
    expect(provider.authorizeUrls[1]?.searchParams.get("organization_hint")).toBe("org-b");
    expect(provider.revoked).toEqual([old.refreshToken]);
    expect(tokensOf(keychain, "default")).toHaveLength(1);
  });

  test("--switch sends no hint, and revokes the old sign-in", async () => {
    await lazco(login("--sso", "--org", "org-b"));
    const old = storedRecord();
    provider.pick = "org-a";
    const switched = await lazco(login("--switch"));
    expect(switched.code).toBe(0);
    expect(provider.authorizeUrls[1]?.searchParams.has("organization_hint")).toBe(false);
    expect(JSON.parse(switched.stdout).organization.id).toBe("org-a");
    expect(switched.stderr).toContain("now signs in to Org A, not Org B");
    expect(provider.revoked).toEqual([old.refreshToken]);
  });

  test("an SSO sign-in that replaces a pasted token revokes nothing", async () => {
    keychain.entries.set(accountOf("default"), FAKE_TOKEN);
    await writeConfig(configPath, {
      version: 1,
      currentProfile: "default",
      profiles: {
        default: {
          apiUrl: provider.apiUrl,
          organization: { id: "org-a", name: "Org A" },
          method: "token",
          credential: { store: "keychain", account: accountOf("default") },
        },
      },
    });
    const run = await lazco(login("--sso"));
    expect(run.code).toBe(0);
    expect(provider.requestsTo("/oidc/revoke")).toHaveLength(0);
    expect(provider.authorizeUrls[0]?.searchParams.has("organization_hint")).toBe(false);
  });

  test("status of a read-only SSO sign-in shows sso and read", async () => {
    await seedKeychainProfile(provider.record({ scope: "read" }));
    const run = await lazco(["auth", "status"]);
    expect(JSON.parse(run.stdout)).toMatchObject({
      profile: "default",
      method: "sso",
      store: "keychain",
      organization: { id: "org-a" },
      scope: "read",
    });
  });

  test("logout revokes with the refresh token and forgets the profile, with no token hint", async () => {
    const record = provider.record({});
    await seedKeychainProfile(record);
    const run = await lazco(["auth", "logout"]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ profile: "default", loggedOut: true });
    expect(provider.revoked).toEqual([record.refreshToken]);
    const [revoke] = provider.requestsTo("/oidc/revoke");
    expect(revoke?.body).toEqual({
      token: record.refreshToken,
      token_type_hint: "refresh_token",
      client_id: "lazco-cli",
    });
    expect(run.stderr).not.toContain("/dashboard/api");
    expect(keychain.entries.size).toBe(0);
    expect((await storedConfig()).profiles).toEqual({});
  });

  test("logout offline still forgets the profile, and fails with CLI_NETWORK", async () => {
    await seedKeychainProfile(provider.record({}));
    const config = await storedConfig();
    (config.profiles.default as { apiUrl: string }).apiUrl = await closedApiUrl();
    await writeConfig(configPath, config);
    const run = await lazco(["auth", "logout"]);
    expect(run.code).toBe(1);
    expect(errorOf(run).code).toBe("CLI_NETWORK");
    expect(errorOf(run).message).toContain("30 days");
    expect(keychain.entries.size).toBe(0);
    expect((await storedConfig()).profiles).toEqual({});
  });
});
