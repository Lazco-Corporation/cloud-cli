import { describe, expect, test } from "bun:test";
import { CliError } from "../../src/core/errors";
import type { SsoRecord } from "../../src/credentials/ssoRecord";
import {
  forgetCredential,
  loadCredential,
  replaceKeychainRecord,
  storeCredential,
} from "../../src/credentials/store";
import { FAKE_TOKEN } from "../helpers/cli";
import { accountOf, brokenKeychain, memoryKeychain, tokensOf } from "../helpers/keychain";

const TOKEN_SECRET = { method: "token", token: FAKE_TOKEN } as const;

const SSO_RECORD: SsoRecord = {
  signInId: "0123456789abcdef",
  issuer: "https://cloud.lazco.tw",
  clientId: "lazco-cli",
  organizationId: "org-1",
  scope: "read",
  accessToken: "a".repeat(64),
  accessTokenExpiresAt: 1_000_000,
  refreshToken: "r".repeat(43),
};

describe("the credential store", () => {
  test("a working keychain holds the token and the config holds none", async () => {
    const keychain = memoryKeychain();
    const result = await storeCredential(keychain, "default", TOKEN_SECRET);
    expect(result).toEqual({
      credential: { store: "keychain", account: expect.stringMatching(/^default@[0-9a-f]{16}$/) },
    });
    expect(tokensOf(keychain, "default")).toEqual([FAKE_TOKEN]);
    expect(await loadCredential(keychain, "default", "token", result.credential)).toEqual(
      TOKEN_SECRET,
    );
    await forgetCredential(keychain, "default", result.credential);
    expect(keychain.entries.size).toBe(0);
  });

  test("an SSO sign-in is one keychain value, read back as the same record", async () => {
    const keychain = memoryKeychain();
    const result = await storeCredential(keychain, "default", { method: "sso", sso: SSO_RECORD });
    expect(result.credential.store).toBe("keychain");
    expect(JSON.parse(tokensOf(keychain, "default")[0] as string)).toEqual(SSO_RECORD);
    expect(await loadCredential(keychain, "default", "sso", result.credential)).toEqual({
      method: "sso",
      sso: SSO_RECORD,
    });
    const refreshed = { ...SSO_RECORD, accessToken: "b".repeat(64) };
    const account = (result.credential as { account: string }).account;
    await replaceKeychainRecord(keychain, "default", account, refreshed);
    expect(await loadCredential(keychain, "default", "sso", result.credential)).toEqual({
      method: "sso",
      sso: refreshed,
    });
  });

  test("a keychain value that is no SSO record is CLI_INTERNAL naming the profile", async () => {
    const keychain = memoryKeychain();
    keychain.entries.set(accountOf("default"), "not json");
    const error = (await loadCredential(keychain, "default", "sso", {
      store: "keychain",
      account: accountOf("default"),
    }).catch((thrown: unknown) => thrown)) as CliError;
    expect(error.code).toBe("CLI_INTERNAL");
    expect(error.message).toContain("profile default");
    expect(error.message).not.toContain("not json");
  });

  test("a throwing keychain falls back to the file store and says why", async () => {
    const result = await storeCredential(brokenKeychain(), "default", TOKEN_SECRET);
    expect(result.credential).toEqual({ store: "file", token: FAKE_TOKEN });
    expect(result.keychainError).toBe("no Secret Service is running");
    expect(await loadCredential(brokenKeychain(), "default", "token", result.credential)).toEqual(
      TOKEN_SECRET,
    );
    const sso = await storeCredential(brokenKeychain(), "default", {
      method: "sso",
      sso: SSO_RECORD,
    });
    expect(sso.credential).toEqual({ store: "file", sso: SSO_RECORD });
  });

  test("a keychain that cannot store a refreshed record is CLI_INTERNAL", async () => {
    const error = (await replaceKeychainRecord(
      brokenKeychain(),
      "default",
      accountOf("default"),
      SSO_RECORD,
    ).catch((thrown: unknown) => thrown)) as CliError;
    expect(error.code).toBe("CLI_INTERNAL");
    expect(error.message).not.toContain(SSO_RECORD.refreshToken);
  });

  test("a keychain that loses the token is treated as no keychain", async () => {
    const forgetful = { ...memoryKeychain(), get: async () => null };
    const result = await storeCredential(forgetful, "default", TOKEN_SECRET);
    expect(result.credential.store).toBe("file");
    expect(result.keychainError).toContain("did not return");
  });

  test("a keychain that keeps a different value is emptied before the file store takes over", async () => {
    const memory = memoryKeychain();
    const mangling = {
      ...memory,
      get: async (account: string) => ((await memory.get(account)) ? "something else" : null),
    };
    const result = await storeCredential(mangling, "default", TOKEN_SECRET);
    expect(result.credential.store).toBe("file");
    expect(memory.entries.size).toBe(0);
  });

  test("a missing keychain entry is CLI_NOT_LOGGED_IN naming the profile", async () => {
    const error = await loadCredential(memoryKeychain(), "staging", "token", {
      store: "keychain",
      account: accountOf("staging"),
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("CLI_NOT_LOGGED_IN");
    expect((error as CliError).message).toContain("--profile staging");
  });

  test("a keychain that cannot delete keeps the error", async () => {
    const error = await forgetCredential(brokenKeychain(), "default", {
      store: "keychain",
      account: accountOf("default"),
    }).catch((thrown: unknown) => thrown);
    expect((error as CliError).code).toBe("CLI_INTERNAL");
  });
});
