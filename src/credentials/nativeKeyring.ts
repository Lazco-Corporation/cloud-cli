/**
 * Loads the native keychain binding.
 *
 * `bun build --compile` does not follow the `createRequire` that
 * `@napi-rs/keyring` uses to find its platform package, so a compiled binary
 * would have no native module and fall back to the file store in silence.
 * `scripts/build-binaries.sh` therefore rewrites the one literal specifier
 * below into the target's own package, such as
 * `@napi-rs/keyring-darwin-arm64`, and fails when it cannot find it.
 * Keep it one literal `import()` in this file.
 */
export async function importKeyringBinding(): Promise<Record<string, unknown>> {
  const loaded: Record<string, unknown> = await import("@napi-rs/keyring");
  return (loaded.AsyncEntry ? loaded : loaded.default) as Record<string, unknown>;
}
