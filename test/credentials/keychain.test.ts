import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { importKeyringBinding } from "../../src/credentials/nativeKeyring";

describe("the keychain module", () => {
  test("the native binding loads and has AsyncEntry, without touching the keychain", async () => {
    const binding = await importKeyringBinding();
    expect(typeof binding.AsyncEntry).toBe("function");
  });

  test("the placeholder the binary build rewrites is one literal import", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "..", "src", "credentials", "nativeKeyring.ts"),
      "utf8",
    );
    expect(source.match(/import\("@napi-rs\/keyring"\)/g)).toHaveLength(1);
  });
});
