import { randomBytes } from "node:crypto";
import type { SignInMethod, StoredCredential } from "../config/configFile";
import { CliError } from "../core/errors";
import type { Keychain } from "./keychain";
import { parseSsoRecord, type SsoRecord } from "./ssoRecord";

/** What a profile's store holds: a pasted API token, or one SSO sign-in. */
export type Secret = { method: "token"; token: string } | { method: "sso"; sso: SsoRecord };

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The keychain value of a secret: the token itself, or the SSO record as JSON. */
function keychainText(secret: Secret): string {
  return secret.method === "token" ? secret.token : JSON.stringify(secret.sso);
}

/** A new keychain account for one login of a profile, such as `default@3fa9c2d17b04e815`. */
export function newKeychainAccount(profileName: string): string {
  return `${profileName}@${randomBytes(8).toString("hex")}`;
}

/** Writes a value to a keychain account and reads it back, so a keychain that loses it throws. */
async function writeKeychain(keychain: Keychain, account: string, text: string): Promise<void> {
  await keychain.set(account, text);
  if ((await keychain.get(account)) !== text) {
    throw new Error("the keychain did not return the value it was given");
  }
}

/**
 * Puts a secret in the keychain under a new account of the profile, which the
 * config file then names, so the entry belongs to that one config file. When
 * the keychain throws, the secret goes into the config file instead, and
 * `keychainError` says why, so login can tell the user.
 */
export async function storeCredential(
  keychain: Keychain,
  profileName: string,
  secret: Secret,
): Promise<{ credential: StoredCredential; keychainError?: string }> {
  const account = newKeychainAccount(profileName);
  try {
    await writeKeychain(keychain, account, keychainText(secret));
    return { credential: { store: "keychain", account } };
  } catch (error) {
    // The config names the file store, so nothing reads this account again.
    // Take out whatever the keychain may still hold.
    await keychain.delete(account).catch(() => undefined);
    return { credential: fileCredential(secret), keychainError: reason(error) };
  }
}

/** The config file's own credential member for a secret. */
export function fileCredential(secret: Secret): StoredCredential {
  return secret.method === "token"
    ? { store: "file", token: secret.token }
    : { store: "file", sso: secret.sso };
}

/**
 * Replaces the SSO record of an existing keychain entry, as a refresh does.
 * A keychain that fails is `CLI_INTERNAL`.
 */
export async function replaceKeychainRecord(
  keychain: Keychain,
  profileName: string,
  account: string,
  sso: SsoRecord,
): Promise<void> {
  try {
    await writeKeychain(keychain, account, keychainText({ method: "sso", sso }));
  } catch (error) {
    throw new CliError(
      "CLI_INTERNAL",
      `The refreshed SSO sign-in of profile ${profileName} could not be stored in the keychain: ${reason(error)}`,
    );
  }
}

/** The secret of a profile, from the store its config names. */
export async function loadCredential(
  keychain: Keychain,
  profileName: string,
  method: SignInMethod,
  credential: StoredCredential,
): Promise<Secret> {
  if (credential.store === "file") {
    // The config schema makes the file hold exactly the member of its method.
    return method === "token"
      ? { method, token: credential.token as string }
      : { method, sso: credential.sso as SsoRecord };
  }
  let text: string | null;
  try {
    text = await keychain.get(credential.account);
  } catch (error) {
    throw new CliError(
      "CLI_INTERNAL",
      `The keychain could not be read for profile ${profileName}: ${reason(error)}`,
    );
  }
  if (!text) {
    throw new CliError(
      "CLI_NOT_LOGGED_IN",
      `The keychain holds no credential for profile ${profileName}: run lazco auth login --profile ${profileName}`,
    );
  }
  return method === "token"
    ? { method, token: text }
    : { method, sso: parseSsoRecord(text, profileName) };
}

/** Removes a profile's secret from its store. A keychain entry that is already gone is fine. */
export async function forgetCredential(
  keychain: Keychain,
  profileName: string,
  credential: StoredCredential,
): Promise<void> {
  if (credential.store === "file") {
    return;
  }
  try {
    await keychain.delete(credential.account);
  } catch (error) {
    throw new CliError(
      "CLI_INTERNAL",
      `The keychain entry of profile ${profileName} could not be deleted, so the profile is kept: ${reason(error)}`,
    );
  }
}
