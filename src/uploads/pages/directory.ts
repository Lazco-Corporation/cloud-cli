import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import nodePath from "node:path";
import { CliError } from "../../core/errors";

/** The `node:path` functions the directory rules use, so a test can pass `path.win32`. */
export type PathFunctions = Pick<
  typeof nodePath,
  "isAbsolute" | "join" | "parse" | "relative" | "resolve" | "sep"
>;

/** One file of the site: its path in the site, where it is on disk, and its size. */
export type SiteFile = { path: string; absolutePath: string; size: number };

export type WalkResult = {
  files: SiteFile[];
  /** The paths left out because a segment starts with `.`, or is `__MACOSX` or `node_modules`. */
  skipped: string[];
};

/** The first bytes of a zip archive: a local file header, an empty archive, or a spanned one. */
const ZIP_SIGNATURES = ["504b0304", "504b0506", "504b0708"];
/** The names the Pages web app leaves out of a deploy, besides every name that starts with `.`. */
const SKIPPED_NAMES: ReadonlySet<string> = new Set(["__MACOSX", "node_modules"]);

function invalid(message: string, details?: unknown): CliError {
  return new CliError("CLI_INVALID_INPUT", message, details);
}

/** True when a path segment is one the walk leaves out, as the Pages web app does. */
export function isSkippedName(name: string): boolean {
  return name.startsWith(".") || SKIPPED_NAMES.has(name);
}

/** The path of a file in the site: relative to the root, with `/` between segments on every system. */
export function sitePath(
  root: string,
  absolutePath: string,
  paths: PathFunctions = nodePath,
): string {
  return paths.relative(root, absolutePath).split(paths.sep).join("/");
}

/** True when `inner` is below `outer`. */
function holds(outer: string, inner: string, paths: PathFunctions): boolean {
  const relative = paths.relative(outer, inner);
  return relative !== "" && relative.split(paths.sep)[0] !== ".." && !paths.isAbsolute(relative);
}

/** True for `/`, `C:\` and `\\server\share\`. */
export function isFilesystemRoot(path: string, paths: PathFunctions = nodePath): boolean {
  const resolved = paths.resolve(path);
  return paths.parse(resolved).root === resolved;
}

async function startsLikeZip(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return bytesRead === 4 && ZIP_SIGNATURES.includes(buffer.toString("hex"));
  } finally {
    await handle.close();
  }
}

/**
 * The real path of the directory to deploy, checked before any request: it
 * exists, it is a directory and not a zip or any other file, and it is not
 * a filesystem root, the home directory, or a directory that holds it. A relative path is refused when
 * `requireAbsolute` is set, as the MCP tool sets it.
 */
export async function resolveSiteDirectory(
  directory: string,
  options: {
    workingDirectory: string;
    homeDirectory: string;
    requireAbsolute: boolean;
    paths?: PathFunctions;
  },
): Promise<string> {
  const paths = options.paths ?? nodePath;
  const problem = (message: string) => invalid(message, [{ field: "directory", message }]);
  if (options.requireAbsolute && !paths.isAbsolute(directory)) {
    throw problem(
      `directory must be an absolute path, because the working directory of the MCP server is the client's choice: ${directory}`,
    );
  }
  const given = paths.resolve(options.workingDirectory, directory);
  let real: string;
  try {
    real = await realpath(given);
  } catch {
    throw problem(`${given} does not exist`);
  }
  const info = await stat(real);
  if (info.isFile()) {
    if (/\.zip$/i.test(real) || (await startsLikeZip(real))) {
      throw problem(
        `${given} is a zip archive. Unpack it first, then deploy the directory it holds`,
      );
    }
    throw problem(`${given} is a file. Deploy the directory that holds the site`);
  }
  if (!info.isDirectory()) {
    throw problem(`${given} is not a directory`);
  }
  if (isFilesystemRoot(real, paths)) {
    throw problem(`${given} is a filesystem root, which is never deployed`);
  }
  let home: string | undefined;
  try {
    home = await realpath(options.homeDirectory);
  } catch {
    home = undefined;
  }
  if (home !== undefined && real === home) {
    throw problem(`${given} is the home directory, which is never deployed`);
  }
  if (home !== undefined && holds(real, home, paths)) {
    throw problem(`${given} holds the home directory, which is never deployed`);
  }
  return real;
}

/**
 * Every regular file below the root, sorted by path. A segment that starts
 * with `.`, or is `__MACOSX` or `node_modules`, is left out and never read.
 * A link or any entry that is neither a file nor a directory is refused and
 * never followed, because the site is public.
 */
export async function walkSiteDirectory(root: string): Promise<WalkResult> {
  const files: SiteFile[] = [];
  const skipped: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const absolutePath = nodePath.join(directory, name);
      const path = sitePath(root, absolutePath);
      if (isSkippedName(name)) {
        skipped.push(path);
        continue;
      }
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        throw invalid(`${path} is a link. A deploy never follows a link, so remove it first`, {
          path,
        });
      }
      if (info.isDirectory()) {
        await visit(absolutePath);
      } else if (info.isFile()) {
        files.push({ path, absolutePath, size: info.size });
      } else {
        throw invalid(`${path} is not a file or a directory, so it cannot be deployed`, { path });
      }
    }
  };
  await visit(root);
  if (files.length === 0) {
    throw invalid(
      `${root} holds no file to deploy${skipped.length > 0 ? ` (${skipped.length} skipped)` : ""}`,
      [{ field: "directory", message: "holds no file to deploy" }],
    );
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files, skipped };
}
