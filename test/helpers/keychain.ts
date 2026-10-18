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
