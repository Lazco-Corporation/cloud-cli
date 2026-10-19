import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliError } from "../../src/core/errors";
import {
  isFilesystemRoot,
  isSkippedName,
  resolveSiteDirectory,
  sitePath,
  walkSiteDirectory,
} from "../../src/uploads/pages/directory";

let base: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "lazco-walk-")));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function put(relative: string, content: string | Uint8Array = "x"): Promise<string> {
  const file = path.join(base, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

async function failure(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a CliError");
}

function resolve(directory: string, options: { home?: string; requireAbsolute?: boolean } = {}) {
  return resolveSiteDirectory(directory, {
    workingDirectory: base,
    homeDirectory: options.home ?? path.join(base, "no-home"),
    requireAbsolute: options.requireAbsolute ?? false,
  });
}

describe("the walk", () => {
  test("files are relative, with / between segments, sorted", async () => {
    await put("site/index.html");
    await put("site/css/site.css");
    await put("site/img/icons/logo.svg", "<svg/>");
    const { files, skipped } = await walkSiteDirectory(path.join(base, "site"));
    expect(files.map((file) => file.path)).toEqual([
      "css/site.css",
      "img/icons/logo.svg",
      "index.html",
    ]);
    expect(files.find((file) => file.path === "img/icons/logo.svg")?.size).toBe(6);
    expect(skipped).toEqual([]);
  });

  test("dot paths, __MACOSX and node_modules are skipped, and counted", async () => {
    await put("site/index.html");
    await put("site/.env", "SECRET=1");
    await put("site/.git/config");
    await put("site/__MACOSX/._index.html");
    await put("site/node_modules/x/index.js");
    await put("site/docs/.hidden/page.html");
    await put("site/.well-known/security.txt");
    const { files, skipped } = await walkSiteDirectory(path.join(base, "site"));
    expect(files.map((file) => file.path)).toEqual(["index.html"]);
    expect(skipped.sort()).toEqual(
      [".env", ".git", ".well-known", "__MACOSX", "docs/.hidden", "node_modules"].sort(),
    );
    expect(isSkippedName(".env")).toBe(true);
    expect(isSkippedName("env")).toBe(false);
  });

  test("a link is refused by its path and never followed", async () => {
    await put("site/index.html");
    await put("secrets/id_ed25519", "private");
    await symlink(path.join(base, "secrets"), path.join(base, "site", "keys"));
    const error = await failure(walkSiteDirectory(path.join(base, "site")));
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.details).toEqual({ path: "keys" });
    expect(error.message).toContain("keys");
  });

  test("a link to a file is refused too", async () => {
    await put("site/index.html");
    await symlink(path.join(base, "site", "index.html"), path.join(base, "site", "home.html"));
    const error = await failure(walkSiteDirectory(path.join(base, "site")));
    expect(error.details).toEqual({ path: "home.html" });
  });

  test("a special file is refused", async () => {
    await put("site/index.html");
    execFileSync("mkfifo", [path.join(base, "site", "pipe")]);
    const error = await failure(walkSiteDirectory(path.join(base, "site")));
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.details).toEqual({ path: "pipe" });
  });

  test("a directory with no file left is refused", async () => {
    await put("site/.env");
    await mkdir(path.join(base, "site", "empty"));
    const error = await failure(walkSiteDirectory(path.join(base, "site")));
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.message).toContain("no file to deploy");
    expect(error.message).toContain("1 skipped");
  });
});

describe("the directory input", () => {
  test("a relative directory resolves against the working directory", async () => {
    await put("site/index.html");
    expect(await resolve("site")).toBe(path.join(base, "site"));
    expect(await resolve("./site/")).toBe(path.join(base, "site"));
  });

  test("a missing path is refused", async () => {
    const error = await failure(resolve("nothing"));
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.message).toContain("does not exist");
  });

  test("a zip archive is refused with a hint to unpack it, by name or by content", async () => {
    await put("site.zip", "PK\u0003\u0004rest");
    const byName = await failure(resolve("site.zip"));
    expect(byName.code).toBe("CLI_INVALID_INPUT");
    expect(byName.message).toContain("Unpack it first");
    await put("archive.bin", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]));
    expect((await failure(resolve("archive.bin"))).message).toContain("Unpack it first");
  });

  test("any other file is refused", async () => {
    await put("index.html");
    const error = await failure(resolve("index.html"));
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.message).toContain("is a file");
  });

  test("the home directory is refused, also through a link", async () => {
    await mkdir(path.join(base, "home"));
    await symlink(path.join(base, "home"), path.join(base, "home-link"));
    const home = path.join(base, "home");
    expect((await failure(resolve("home", { home }))).message).toContain("home directory");
    expect((await failure(resolve("home-link", { home }))).message).toContain("home directory");
  });

  test("a directory that holds the home directory is refused, as /Users is", async () => {
    await mkdir(path.join(base, "users", "me"), { recursive: true });
    await put("users/me-site/index.html");
    const home = path.join(base, "users", "me");
    const error = await failure(resolve("users", { home }));
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.message).toContain("holds the home directory");
    expect(await resolve("users/me-site", { home })).toBe(path.join(base, "users", "me-site"));
  });

  test("a filesystem root is refused", async () => {
    const error = await failure(resolve("/"));
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.message).toContain("filesystem root");
  });

  test("the MCP tool refuses a relative path before it looks at the disk", async () => {
    await put("site/index.html");
    const error = await failure(resolve("site", { requireAbsolute: true }));
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.message).toContain("absolute");
    expect(await resolve(path.join(base, "site"), { requireAbsolute: true })).toBe(
      path.join(base, "site"),
    );
  });
});

describe("Windows paths", () => {
  test("a site path uses / whatever the system's separator", () => {
    expect(sitePath("C:\\Users\\me\\dist", "C:\\Users\\me\\dist\\css\\site.css", path.win32)).toBe(
      "css/site.css",
    );
    expect(sitePath("C:\\Users\\me\\dist", "C:\\Users\\me\\dist\\index.html", path.win32)).toBe(
      "index.html",
    );
  });

  test("a drive root and a share root are filesystem roots, a folder is not", () => {
    expect(isFilesystemRoot("C:\\", path.win32)).toBe(true);
    expect(isFilesystemRoot("\\\\server\\share\\", path.win32)).toBe(true);
    expect(isFilesystemRoot("C:\\Users\\me\\dist", path.win32)).toBe(false);
    expect(isFilesystemRoot("/", path.posix)).toBe(true);
  });

  test("a drive path is absolute for the MCP tool, a bare folder is not", async () => {
    const error = await failure(
      resolveSiteDirectory("dist", {
        workingDirectory: "C:\\work",
        homeDirectory: "C:\\Users\\me",
        requireAbsolute: true,
        paths: path.win32,
      }),
    );
    expect(error.message).toContain("absolute");
    expect(path.win32.isAbsolute("C:\\Users\\me\\dist")).toBe(true);
  });
});
