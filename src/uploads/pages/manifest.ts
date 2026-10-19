import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CliError } from "../../core/errors";
import type { SiteFile } from "./directory";
import { type DeployRules, isContentFile } from "./rules";

/** One file of the deploy start's manifest. */
export type ManifestEntry = {
  path: string;
  size: number;
  /** Lowercase hex SHA-256 of the file bytes. */
  sha256: string;
  /** The exact file bytes, for a content file only. */
  contentBase64?: string;
};

/** Files hashed at once. Each is read whole, and a file holds at most the file limit. */
const HASH_CONCURRENCY = 8;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The bytes of a file, refused when its size is not the size the deploy
 * counted, because the file changed during the deploy.
 */
export async function readSiteFile(file: SiteFile): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file.absolutePath);
  } catch (error) {
    throw new CliError("CLI_INVALID_INPUT", `${file.path} could not be read`, {
      path: file.path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (bytes.length !== file.size) {
    throw changedDuringDeploy(file.path);
  }
  return bytes;
}

export function changedDuringDeploy(path: string): CliError {
  return new CliError(
    "CLI_INVALID_INPUT",
    `${path} changed during the deploy. Deploy again once the build is done`,
    { path },
  );
}

/**
 * The manifest of the deploy start: path, size and SHA-256 of every file, in
 * the order given, and the bytes in base64 of each file whose extension is a
 * content extension. The bytes stay in memory.
 */
export async function buildManifest(
  files: readonly SiteFile[],
  rules: DeployRules,
  options: { signal?: AbortSignal; onHashed?: (count: number) => void } = {},
): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = new Array(files.length);
  let next = 0;
  let hashed = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      options.signal?.throwIfAborted();
      const index = next;
      next += 1;
      const file = files[index];
      if (file === undefined) {
        return;
      }
      const bytes = await readSiteFile(file);
      const entry: ManifestEntry = { path: file.path, size: file.size, sha256: sha256Hex(bytes) };
      if (isContentFile(file.path, rules)) {
        entry.contentBase64 = bytes.toString("base64");
      }
      entries[index] = entry;
      hashed += 1;
      options.onHashed?.(hashed);
    }
  };
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, files.length) }, worker));
  return entries;
}
