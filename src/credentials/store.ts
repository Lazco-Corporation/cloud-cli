import type { StoredCredential } from "../config/configFile";
import { CliError } from "../core/errors";
import type { Keychain } from "./keychain";

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Puts a token in the keychain under the profile's name. When the keychain
 * throws, the token goes into the config file instead, and `keychainError`
 * says why, so login can tell the user.
 */
export async function storeCredential(
  keychain: Keychain,
  profileName: string,
  token: string,
): Promise<{ credential: StoredCredential; keychainError?: string }> {
  try {
    await keychain.set(profileName, token);
    if ((await keychain.get(profileName)) !== token) {
      throw new Error("the keychain did not return the token it was given");
    }
    return { credential: { store: "keychain" } };
  } catch (error) {
    return { credential: { store: "file", token }, keychainError: reason(error) };
  }
}

/** The token of a profile, from the store its config names. */
export async function loadCredential(
  keychain: Keychain,
  profileName: string,
  credential: StoredCredential,
): Promise<string> {
  if (credential.store === "file") {
    return credential.token;
  }
  let token: string | null;
  try {
    token = await keychain.get(profileName);
  } catch (error) {
    throw new CliError(
      "CLI_INTERNAL",
      `The keychain could not be read for profile ${profileName}: ${reason(error)}`,
    );
  }
  if (!token) {
    throw new CliError(
      "CLI_NOT_LOGGED_IN",
      `The keychain holds no token for profile ${profileName}: run lazco auth login --profile ${profileName}`,
    );
  }
  return token;
}

/** Removes a profile's token from its store. A keychain entry that is already gone is fine. */
export async function forgetCredential(
  keychain: Keychain,
  profileName: string,
  credential: StoredCredential,
): Promise<void> {
  if (credential.store === "file") {
    return;
  }
  try {
    await keychain.delete(profileName);
  } catch (error) {
    throw new CliError(
      "CLI_INTERNAL",
      `The keychain entry of profile ${profileName} could not be deleted, so the profile is kept: ${reason(error)}`,
    );
  }
}
