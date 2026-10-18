import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Writes the whole file to a temporary name in the same directory, then
 * renames it, so a reader in another process never sees half a file.
 */
export async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temporaryPath, content, { mode });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

/** The parsed JSON of a file, or `undefined` when it is missing or not valid JSON. */
export async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
