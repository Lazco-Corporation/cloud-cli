import { describe, expect, test } from "bun:test";
import { CliError } from "../../src/core/errors";
import { forgetCredential, loadCredential, storeCredential } from "../../src/credentials/store";
import { FAKE_TOKEN } from "../helpers/cli";
import { brokenKeychain, memoryKeychain } from "../helpers/keychain";

describe("the credential store", () => {
  test("a working keychain holds the token and the config holds none", async () => {
    const keychain = memoryKeychain();
    const result = await storeCredential(keychain, "default", FAKE_TOKEN);
    expect(result).toEqual({ credential: { store: "keychain" } });
    expect(keychain.entries.get("default")).toBe(FAKE_TOKEN);
    expect(await loadCredential(keychain, "default", result.credential)).toBe(FAKE_TOKEN);
    await forgetCredential(keychain, "default", result.credential);
    expect(keychain.entries.has("default")).toBe(false);
  });

  test("a throwing keychain falls back to the file store and says why", async () => {
    const result = await storeCredential(brokenKeychain(), "default", FAKE_TOKEN);
    expect(result.credential).toEqual({ store: "file", token: FAKE_TOKEN });
    expect(result.keychainError).toBe("no Secret Service is running");
    expect(await loadCredential(brokenKeychain(), "default", result.credential)).toBe(FAKE_TOKEN);
  });

  test("a keychain that loses the token is treated as no keychain", async () => {
    const forgetful = { ...memoryKeychain(), get: async () => null };
    const result = await storeCredential(forgetful, "default", FAKE_TOKEN);
    expect(result.credential.store).toBe("file");
    expect(result.keychainError).toContain("did not return");
  });

  test("a missing keychain entry is CLI_NOT_LOGGED_IN naming the profile", async () => {
    const error = await loadCredential(memoryKeychain(), "staging", { store: "keychain" }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("CLI_NOT_LOGGED_IN");
    expect((error as CliError).message).toContain("--profile staging");
  });

  test("a keychain that cannot delete keeps the error", async () => {
    const error = await forgetCredential(brokenKeychain(), "default", { store: "keychain" }).catch(
      (thrown: unknown) => thrown,
    );
    expect((error as CliError).code).toBe("CLI_INTERNAL");
  });
});
