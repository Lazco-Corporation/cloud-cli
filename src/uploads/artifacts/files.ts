import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import nodePath from "node:path";
import { CliError } from "../../core/errors";
import { ARTIFACT_FILES_INPUT, ARTIFACT_PATH_INPUT } from "../../core/generate/annotation";
import { holds, isFilesystemRoot } from "../pages/directory";

/** The most a publish holds, decoded, as the API's limit. */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
/** The most files a publish holds, as the API's limit. */
export const MAX_ARTIFACT_FILES = 100;

export type ArtifactEncoding = "utf-8" | "base64";

/** One file of the body the API takes. */
export type ArtifactFile = { path: string; encoding: ArtifactEncoding; content: string };

/** One local file to publish: its path in the artifact, where it is on disk, and its size. */
export type LocalArtifactFile = { path: string; absolutePath: string; size: number };

export type LocalArtifact = {
  /** The real path the input names. */
  root: string;
  files: LocalArtifactFile[];
  /** The paths left out of a directory because a segment starts with `.`. */
  skipped: string[];
};

/**
 * The types a publish may hold, by lowercase extension, with the encoding
 * each is sent in. Text goes as UTF-8, so the API can scan and parse it.
 */
const ENCODING_BY_EXTENSION: ReadonlyMap<string, ArtifactEncoding> = new Map([
  [".html", "utf-8"],
  [".htm", "utf-8"],
  [".md", "utf-8"],
  [".css", "utf-8"],
  [".svg", "utf-8"],
  [".png", "base64"],
  [".jpg", "base64"],
  [".jpeg", "base64"],
  [".gif", "base64"],
  [".webp", "base64"],
  [".avif", "base64"],
  [".woff2", "base64"],
  [".woff", "base64"],
]);

function invalid(message: string, details?: unknown): CliError {
  return new CliError("CLI_INVALID_INPUT", message, details);
}

/** The encoding of a file by its extension, or `undefined` for a type a publish may not hold. */
export function encodingOf(path: string): ArtifactEncoding | undefined {
  return ENCODING_BY_EXTENSION.get(nodePath.posix.extname(path).toLowerCase());
}

function mebibytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

/**
 * Refuses a set of files the API would refuse for its types, its count or
 * its size, so nothing is sent. The sizes are the decoded bytes.
 */
export function checkArtifactLimits(
  files: ReadonlyArray<{ path: string; size: number }>,
  field: string,
): void {
  const unknownType = files.filter((file) => encodingOf(file.path) === undefined);
  if (unknownType.length > 0) {
    throw invalid(
      `A publish holds only HTML, Markdown, CSS, images and fonts, so ${unknownType
        .map((file) => file.path)
        .join(", ")} cannot be published`,
      {
        field,
        files: unknownType.map((file) => file.path),
        allowed: [...ENCODING_BY_EXTENSION.keys()],
      },
    );
  }
  if (files.length > MAX_ARTIFACT_FILES) {
    throw invalid(
      `A publish holds at most ${MAX_ARTIFACT_FILES} files, and this one has ${files.length}`,
      { field, files: files.length, limit: MAX_ARTIFACT_FILES },
    );
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_ARTIFACT_BYTES) {
    throw invalid(
      `A publish holds at most ${mebibytes(MAX_ARTIFACT_BYTES)}, and this one has ${mebibytes(totalBytes)}`,
      { field, bytes: totalBytes, limit: MAX_ARTIFACT_BYTES },
    );
  }
}

/** The decoded size of a file the input gives directly. */
export function decodedSize(file: ArtifactFile): number {
  return file.encoding === "base64"
    ? Buffer.from(file.content, "base64").length
    : Buffer.byteLength(file.content, "utf8");
}

/**
 * Reads a local file or directory to publish, and checks it against the
 * limits before any file is read. A file is published under its own name. A
 * directory gives every regular file below it, by its path from the
 * directory with `/` between segments, and leaves out every segment that
 * starts with `.`. A link inside a directory is refused and never followed.
 * A filesystem root, the home directory and a directory that holds it are
 * refused. A relative path is refused when `requireAbsolute` is set, as the
 * MCP tool sets it.
 */
export async function readLocalArtifact(
  localPath: string,
  options: { workingDirectory: string; homeDirectory: string; requireAbsolute: boolean },
): Promise<LocalArtifact> {
  const problem = (message: string) => invalid(message, [{ field: ARTIFACT_PATH_INPUT, message }]);
  if (options.requireAbsolute && !nodePath.isAbsolute(localPath)) {
    throw problem(
      `path must be an absolute path, because the working directory of the MCP server is the client's choice: ${localPath}`,
    );
  }
  const given = nodePath.resolve(options.workingDirectory, localPath);
  let root: string;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    root = await realpath(given);
    info = await stat(root);
  } catch {
    throw problem(`${given} does not exist or cannot be read`);
  }
  if (info.isFile()) {
    const files = [{ path: nodePath.basename(root), absolutePath: root, size: info.size }];
    checkArtifactLimits(files, ARTIFACT_PATH_INPUT);
    return { root, files, skipped: [] };
  }
  if (!info.isDirectory()) {
    throw problem(`${given} is not a file or a directory`);
  }
  if (isFilesystemRoot(root)) {
    throw problem(`${given} is a filesystem root, which is never published`);
  }
  const home = await realpath(options.homeDirectory).catch(() => undefined);
  if (home !== undefined && (root === home || holds(root, home, nodePath))) {
    throw problem(`${given} is or holds the home directory, which is never published`);
  }
  const { files, skipped } = await walkArtifactDirectory(root);
  checkArtifactLimits(files, ARTIFACT_PATH_INPUT);
  return { root, files, skipped };
}

async function walkArtifactDirectory(
  root: string,
): Promise<{ files: LocalArtifactFile[]; skipped: string[] }> {
  const files: LocalArtifactFile[] = [];
  const skipped: string[] = [];
  const pathInArtifact = (absolutePath: string) =>
    nodePath.relative(root, absolutePath).split(nodePath.sep).join("/");
  const unreadable = (path: string, error: unknown) =>
    invalid(`${path || "."} could not be read`, {
      path: path || ".",
      cause: error instanceof Error ? error.message : String(error),
    });
  const visit = async (directory: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(directory)).sort();
    } catch (error) {
      throw unreadable(pathInArtifact(directory), error);
    }
    for (const name of names) {
      const absolutePath = nodePath.join(directory, name);
      const path = pathInArtifact(absolutePath);
      if (name.startsWith(".")) {
        skipped.push(path);
        continue;
      }
      let entry: Awaited<ReturnType<typeof lstat>>;
      try {
        entry = await lstat(absolutePath);
      } catch (error) {
        throw unreadable(path, error);
      }
      if (entry.isSymbolicLink()) {
        throw invalid(`${path} is a link. A publish never follows a link, so remove it first`, {
          path,
        });
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push({ path, absolutePath, size: entry.size });
        // A directory far over the limit is refused without walking all of it.
        if (files.length > MAX_ARTIFACT_FILES) {
          throw invalid(
            `A publish holds at most ${MAX_ARTIFACT_FILES} files, and ${root} has more`,
            { field: ARTIFACT_PATH_INPUT, files: files.length, limit: MAX_ARTIFACT_FILES },
          );
        }
      } else {
        throw invalid(`${path} is not a file or a directory, so it cannot be published`, {
          path,
        });
      }
    }
  };
  await visit(root);
  if (files.length === 0) {
    throw invalid(
      `${root} holds no file to publish${skipped.length > 0 ? ` (${skipped.length} skipped)` : ""}`,
      [{ field: ARTIFACT_PATH_INPUT, message: "holds no file to publish" }],
    );
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files, skipped };
}

/**
 * The files of the body: text as UTF-8, everything else as base64. A text
 * file that is not valid UTF-8 is refused, as the API would refuse it.
 */
export async function encodeArtifactFiles(
  files: readonly LocalArtifactFile[],
): Promise<ArtifactFile[]> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return Promise.all(
    files.map(async (file) => {
      const bytes = await readFile(file.absolutePath);
      const encoding = encodingOf(file.path) as ArtifactEncoding;
      if (encoding === "base64") {
        return { path: file.path, encoding, content: bytes.toString("base64") };
      }
      try {
        return { path: file.path, encoding, content: decoder.decode(bytes) };
      } catch {
        throw invalid(`${file.path} is not valid UTF-8, so it cannot be published as text`, {
          field: ARTIFACT_PATH_INPUT,
          path: file.path,
        });
      }
    }),
  );
}

/** The files the input gives directly, checked against the same limits. */
export function checkGivenFiles(files: readonly ArtifactFile[]): void {
  checkArtifactLimits(
    files.map((file) => ({ path: file.path, size: decodedSize(file) })),
    ARTIFACT_FILES_INPUT,
  );
}
