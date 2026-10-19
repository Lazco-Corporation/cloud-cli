import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "../../src/core/errors";
import {
  checkLimits,
  type DeployRules,
  extensionOf,
  parseDeployRules,
} from "../../src/uploads/pages/rules";
import { cliEnv, FAKE_TOKEN, makeHome, runInProcess } from "../helpers/cli";
import { PagesApi } from "../helpers/pagesApi";

let api: PagesApi;
let home: Awaited<ReturnType<typeof makeHome>>;
let site: string;

beforeEach(async () => {
  api = new PagesApi();
  home = await makeHome();
  site = path.join(await realpath(home.home), "site");
  await mkdir(site);
});

afterEach(async () => {
  api.stop();
  await chmod(site, 0o755).catch(() => {});
  await home.cleanup();
});

async function put(relative: string, size: number): Promise<string> {
  const file = path.join(site, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "a".repeat(size));
  return file;
}

async function deploy() {
  const run = await runInProcess(
    ["--api-url", api.apiUrl, "labs", "pages", "deployments", "create", "site-1", site],
    { env: cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN }) },
  );
  const error = run.stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line).error)[0];
  return { ...run, error };
}

function limits(overrides: Partial<PagesApi["state"]["rules"]["limits"]>) {
  api.state.rules = { ...api.state.rules, limits: { ...api.state.rules.limits, ...overrides } };
}

describe("the limits, from the sizes alone, before any write", () => {
  test("fileCount, before any file is read", async () => {
    limits({ fileCount: 3 });
    for (const name of ["a.png", "b.png", "c.png", "d.png"]) {
      await put(name, 10);
    }
    // An unreadable file proves no file is read before the count is checked.
    await chmod(path.join(site, "a.png"), 0o000);
    const run = await deploy();
    expect(run.code).toBe(1);
    expect(run.error.code).toBe("CLI_INVALID_INPUT");
    expect(run.error.details).toEqual({ limit: "fileCount", max: 3, actual: 4 });
    expect(api.sentWrites()).toBe(false);
    expect(api.apiCalls()).toEqual([
      "GET /v1/labs/pages/deploy-rules",
      "GET /v1/labs/pages/sites/site-1",
    ]);
  });

  test("fileBytes names the file", async () => {
    limits({ fileBytes: 100 });
    await put("index.html", 10);
    await put("video/clip.mp4", 101);
    const run = await deploy();
    expect(run.error.code).toBe("CLI_INVALID_INPUT");
    expect(run.error.details).toEqual({
      limit: "fileBytes",
      max: 100,
      actual: 101,
      path: "video/clip.mp4",
    });
    expect(api.sentWrites()).toBe(false);
  });

  test("totalBytes", async () => {
    limits({ totalBytes: 150 });
    await put("a.png", 80);
    await put("b.png", 80);
    const run = await deploy();
    expect(run.error.details).toEqual({ limit: "totalBytes", max: 150, actual: 160 });
    expect(api.sentWrites()).toBe(false);
  });

  test("textBytes counts the content files only", async () => {
    limits({ textBytes: 50 });
    await put("photo.png", 500);
    await put("index.html", 30);
    await put("css/SITE.CSS", 30);
    const run = await deploy();
    expect(run.error.code).toBe("CLI_INVALID_INPUT");
    expect(run.error.details).toEqual({ limit: "textBytes", max: 50, actual: 60 });
    expect(api.sentWrites()).toBe(false);
  });

  test("a site that is not active is refused before the directory is read", async () => {
    api.state.site = { ...api.state.site, status: "suspended" };
    await put("index.html", 10);
    const run = await deploy();
    expect(run.error.code).toBe("CLI_INVALID_INPUT");
    expect(run.error.details).toEqual({ siteId: "site-1", status: "suspended" });
    expect(run.error.message).toContain("suspended");
    expect(api.sentWrites()).toBe(false);
  });

  test("an API error of a read passes through, and nothing is written", async () => {
    await put("index.html", 10);
    const run = await runInProcess(
      ["--api-url", api.apiUrl, "labs", "pages", "deployments", "create", "site-9", site],
      { env: cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN }) },
    );
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stderr.trim().split("\n").at(-1) as string).error).toEqual(
      expect.objectContaining({ status: 404, code: "NOT_FOUND" }),
    );
    expect(api.sentWrites()).toBe(false);
  });
});

describe("the rules", () => {
  const rules: DeployRules = parseDeployRules({
    limits: { fileBytes: "100", totalBytes: 1000, fileCount: 10, textBytes: 50 },
    contentExtensions: ["css", "html", "svg"],
    lastExtensions: ["html"],
    uploadUrlTtlSeconds: 3600,
  });

  test("a whole number may come as a string, and the extension lists become sets", () => {
    expect(rules.limits).toEqual({
      fileBytes: 100,
      totalBytes: 1000,
      fileCount: 10,
      textBytes: 50,
    });
    expect([...rules.contentExtensions]).toEqual(["css", "html", "svg"]);
  });

  test("an answer without a limit is CLI_BAD_RESPONSE", () => {
    expect(() =>
      parseDeployRules({ limits: {}, contentExtensions: [], lastExtensions: [] }),
    ).toThrow(CliError);
  });

  test("the extension is the lowercase text after the last dot of the last segment", () => {
    expect(extensionOf("INDEX.HTML")).toBe("html");
    expect(extensionOf("a.b/c")).toBe("");
    expect(extensionOf("js/app.min.mjs")).toBe("mjs");
    expect(extensionOf("Makefile")).toBe("");
  });

  test("a deploy at each limit passes", () => {
    expect(() =>
      checkLimits(
        [
          { path: "index.html", absolutePath: "/x", size: 50 },
          { path: "a.png", absolutePath: "/y", size: 100 },
        ],
        rules,
      ),
    ).not.toThrow();
  });
});
