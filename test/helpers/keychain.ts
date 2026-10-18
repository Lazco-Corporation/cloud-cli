import type { Keychain } from "../../src/credentials/keychain";

/** A keychain in memory, so no test touches the real one. */
export function memoryKeychain(): Keychain & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    set: async (account, secret) => {
      entries.set(account, secret);
    },
    get: async (account) => entries.get(account) ?? null,
    delete: async (account) => entries.delete(account),
  };
}

/** A keychain that throws on every call, as on a Linux host with no Secret Service. */
export function brokenKeychain(message = "no Secret Service is running"): Keychain {
  const fail = async (): Promise<never> => {
    throw new Error(message);
  };
  return { set: fail, get: fail, delete: fail };
}

/** The keychain account of a profile in a seeded config file, with a fixed suffix. */
export function accountOf(profile: string): string {
  return `${profile}@${"0".repeat(16)}`;
}

/** Every token the keychain holds for a profile, whatever the suffix of its account. */
export function tokensOf(keychain: { entries: Map<string, string> }, profile: string): string[] {
  return [...keychain.entries]
    .filter(([account]) => account.startsWith(`${profile}@`))
    .map(([, token]) => token);
}
