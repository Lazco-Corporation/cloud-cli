import type { AsyncEntry, EntryOptions } from "@napi-rs/keyring";
import { importKeyringBinding } from "./nativeKeyring";

/**
 * The keychain service of every entry. The account is the profile name and a
 * random suffix of one login, which the config file names.
 */
export const KEYCHAIN_SERVICE = "tw.lazco.cli";

/**
 * Pins Linux to the Secret Service. Without it the library falls back to the
 * kernel keyring, which a reboot clears. Other platforms ignore it.
 */
const ENTRY_OPTIONS: EntryOptions = { linux: { store: "secret-service" } };

/** The OS keychain as the credential store sees it, so tests can supply their own. */
export type Keychain = {
  set(account: string, secret: string): Promise<void>;
  /** `null` when there is no entry. */
  get(account: string): Promise<string | null>;
  /** `false` when there was no entry. */
  delete(account: string): Promise<boolean>;
};

type AsyncEntryClass = new (
  service: string,
  username: string,
  options?: EntryOptions,
) => AsyncEntry;

/** The macOS Keychain, the Windows Credential Manager or the Linux Secret Service. */
export function osKeychain(): Keychain {
  let entryClass: Promise<AsyncEntryClass> | undefined;
  const entry = async (account: string): Promise<AsyncEntry> => {
    entryClass ??= importKeyringBinding().then((binding) => {
      if (typeof binding.AsyncEntry !== "function") {
        throw new Error("the keychain module has no AsyncEntry");
      }
      return binding.AsyncEntry as AsyncEntryClass;
    });
    const AsyncEntryOfPlatform = await entryClass;
    return new AsyncEntryOfPlatform(KEYCHAIN_SERVICE, account, ENTRY_OPTIONS);
  };
  return {
    set: async (account, secret) => (await entry(account)).setPassword(secret),
    get: async (account) => (await entry(account)).getPassword(),
    delete: async (account) => (await entry(account)).deleteCredential(),
  };
}
