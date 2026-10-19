import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { cliEnv, FAKE_TOKEN, makeHome, runInProcess } from "../helpers/cli";
import { fakeClock } from "../helpers/fakeApi";
import { loadFixture } from "../helpers/fixtures";
import { type ConnectedSession, connectSession, resultJson } from "../helpers/mcp";
import { PagesApi } from "../helpers/pagesApi";

let api: PagesApi;
let home: Awaited<ReturnType<typeof makeHome>>;
let site: string;
let connected: ConnectedSession | undefined;

const SITE = {
  "index.html": "<link href=css/site.css><img src=img/logo.svg>",
  "about/index.html": "<p>about</p>",
  "css/site.css": "body{color:red}",
  "js/app.mjs": "export {}",
  "img/logo.svg": "<svg/>",
  "img/photo.png": "png",
  ".env": "SECRET=1",
};

async function writeSite(root: string, contents: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(contents)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
}

beforeEach(async () => {
  api = new PagesApi();
  home = await makeHome();
  site = path.join(await realpath(home.home), "site");
  await writeSite(site, SITE);
});

afterEach(async () => {
  await connected?.close();
  connected = undefined;
  api.stop();
  await home.cleanup();
});

function deploy(...extra: string[]) {
  return runInProcess(
    ["--api-url", api.apiUrl, "labs", "pages", "deployments", "create", "site-1", site, ...extra],
    { env: cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN }), clock: fakeClock(Date.now()) },
  );
}

describe("the result and the progress", () => {
  test("stdout holds one JSON object with the deployment, the site and the counts", async () => {
    const run = await deploy();
    expect(run.code).toBe(0);
    expect(run.stdout.trim().split("\n")).toHaveLength(1);
    expect(run.stdout).not.toContain("\u001b");
    const result = JSON.parse(run.stdout);
    expect(result).toEqual({
      deployment: expect.objectContaining({ id: "dep-1", status: "live" }),
      site: {
        id: "site-1",
        hostname: "docs.staging.lazco.page",
        url: "https://docs.staging.lazco.page/",
      },
      index: { rule: "root_index", indexDocument: "index.html" },
      files: 6,
      uploaded: 6,
      unchanged: 0,
      totalBytes: 91,
      uploadedBytes: 91,
    });
    expect(run.stderr).toContain("lazco: found 6 files");
    expect(run.stderr).toContain("skipped 1: .env");
    expect(run.stderr).toContain("lazco: uploading 6 files");
    expect(run.stderr).toContain("lazco: finalizing the deployment dep-1");
    expect(run.stderr).toContain("lazco: the deployment dep-1 is live");
    expect(api.puts()).not.toContain(".env");
    expect(api.state.stored.has(".env")).toBe(false);
  });

  test("the HTML files upload last, and the manifest never lists .env", async () => {
    await deploy();
    const puts = api.puts();
    expect(puts.slice(-2).sort()).toEqual(["about/index.html", "index.html"]);
    const start = api.requests.find((request) => request.path.endsWith("/deployments"));
    const body = start?.body as { files: Array<{ path: string; contentBase64?: string }> };
    const files = body.files;
    expect(files.map((file) => file.path)).toEqual([
      "about/index.html",
      "css/site.css",
      "img/logo.svg",
      "img/photo.png",
      "index.html",
      "js/app.mjs",
    ]);
    expect(files.find((file) => file.path === "img/photo.png")?.contentBase64).toBeUndefined();
  });

  test("a redeploy with one changed file uploads one", async () => {
    expect((await deploy()).code).toBe(0);
    await writeFile(path.join(site, "css/site.css"), "body{color:blue}");
    const second = await deploy();
    expect(second.code).toBe(0);
    const result = JSON.parse(second.stdout);
    expect([result.uploaded, result.unchanged, result.uploadedBytes]).toEqual([1, 5, 16]);
    expect(api.puts().filter((put) => put === "css/site.css")).toHaveLength(2);
  });

  test("--human prints the same result as text", async () => {
    const run = await deploy("--human");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("uploaded:");
    expect(run.stdout).toContain("https://docs.staging.lazco.page/");
    expect(() => JSON.parse(run.stdout)).toThrow();
  });

  test("--dry-run sends only the two reads and prints the start without file bytes", async () => {
    const run = await deploy("--dry-run");
    expect(run.code).toBe(0);
    expect(api.apiCalls()).toEqual([
      "GET /v1/labs/pages/deploy-rules",
      "GET /v1/labs/pages/sites/site-1",
    ]);
    expect(api.sentWrites()).toBe(false);
    const preview = JSON.parse(run.stdout);
    expect(preview).toEqual(
      expect.objectContaining({
        dryRun: true,
        method: "POST",
        url: `${api.apiUrl}/labs/pages/sites/site-1/deployments`,
      }),
    );
    expect(preview.headers.Authorization).toBeUndefined();
    const css = preview.body.files.find((file: { path: string }) => file.path === "css/site.css");
    expect(css).toEqual({
      path: "css/site.css",
      size: 15,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      contentBase64Length: 20,
    });
    expect(JSON.stringify(preview)).not.toContain(
      Buffer.from("body{color:red}").toString("base64"),
    );
  });

  test("no index document is a warning on stderr, and the deploy goes on", async () => {
    api.state.indexRule = "not_found";
    const run = await deploy();
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("lazco: warning: the deploy has no index document");
    expect(JSON.parse(run.stdout).index).toEqual({ rule: "not_found", indexDocument: null });
  });

  test("an error of the deploy start passes through as the API sent it", async () => {
    api.state.deployments.set("dep-0", {
      id: "dep-0",
      siteId: "site-1",
      status: "uploading",
      fileCount: 1,
      totalBytes: 1,
      indexDocumentChoice: null,
      uploadExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      finalizedAt: null,
      error: null,
      createdAt: new Date().toISOString(),
      files: [],
      generation: 0,
      polls: 0,
    });
    const run = await deploy();
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stderr.trim().split("\n").at(-1) as string).error).toEqual(
      expect.objectContaining({ status: 409, code: "PAGES_DEPLOYMENT_IN_PROGRESS" }),
    );
  });
});

describe("the MCP tool", () => {
  async function start(scope = "read_write", allowWrites = true): Promise<ConnectedSession> {
    api.state.scope = scope;
    connected = await connectSession(api, {
      allowWrites,
      cacheDirectory: home.cache,
      clock: fakeClock(Date.now()),
    });
    return connected;
  }

  test("deploys an absolute directory, returns the result, and reports progress", async () => {
    const session = await start();
    const progress: string[] = [];
    const result = await session.client.callTool(
      { name: "labs_pages_create_deployment", arguments: { id: "site-1", directory: site } },
      undefined,
      { onprogress: (update) => progress.push(update.message ?? "") },
    );
    expect(result.isError).toBeUndefined();
    const body = resultJson(result) as { deployment: { status: string }; site: { url: string } };
    expect(body.deployment.status).toBe("live");
    expect(body.site.url).toBe("https://docs.staging.lazco.page/");
    expect(progress.some((message) => message.startsWith("uploading 6 files"))).toBe(true);
    expect(progress.at(-1)).toBe("the deployment dep-1 is live");
  });

  test("a relative directory is CLI_INVALID_INPUT, and no request is sent", async () => {
    const session = await start();
    const before = api.apiCalls().length;
    const result = await session.client.callTool({
      name: "labs_pages_create_deployment",
      arguments: { id: "site-1", directory: "site" },
    });
    expect(result.isError).toBe(true);
    expect((resultJson(result) as { error: { code: string } }).error.code).toBe(
      "CLI_INVALID_INPUT",
    );
    expect(api.apiCalls().length).toBe(before);
  });

  test("a read-only session and a session without --allow-writes have no deploy tool", async () => {
    for (const [scope, allowWrites] of [
      ["read", true],
      ["read_write", false],
    ] as const) {
      const session = await start(scope, allowWrites);
      const names = (await session.client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("labs_pages_get_deployment");
      expect(names).not.toContain("labs_pages_create_deployment");
      await session.close();
      connected = undefined;
    }
  });

  test("the tool's input schema is the site and the directory", async () => {
    const session = await start();
    const tool = (await session.client.listTools()).tools.find(
      (candidate) => candidate.name === "labs_pages_create_deployment",
    );
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["id", "directory"]);
    expect(tool?.inputSchema.required).toEqual(["id", "directory"]);
    expect(tool?.annotations).toEqual(
      expect.objectContaining({ readOnlyHint: false, destructiveHint: false }),
    );
  });
});

describe("Idempotency-Key and the uploader's own POSTs", () => {
  const keyOf = (request: { headers: Record<string, string> }) =>
    request.headers["idempotency-key"];
  const posts = () => api.requests.filter((request) => request.method === "POST");

  test("no POST of a deploy carries a key while its routes declare none", async () => {
    const run = await deploy();
    expect(run.code).toBe(0);
    expect(posts().map((request) => request.path.split("/").pop())).toEqual([
      "deployments",
      "finalize",
    ]);
    expect(posts().map(keyOf)).toEqual([undefined, undefined]);
  });

  test("so the client never sends a finalize again by itself: only the uploader's own read decides", async () => {
    let finalizes = 0;
    api.state.answer = (request) => {
      if (request.method === "POST" && request.path.endsWith("/finalize")) {
        finalizes += 1;
        if (finalizes === 1) {
          return new Response("bad gateway", { status: 502 });
        }
      }
      return undefined;
    };
    const run = await deploy();
    expect(run.code).toBe(1);
    expect(finalizes).toBe(1);
  });

  test("a start that declares the header carries the run's key, and finalize carries none", async () => {
    const spec = loadFixture("pages");
    const start = spec.paths["/v1/labs/pages/sites/{id}/deployments"]?.post;
    if (!start) throw new Error("fixture changed");
    start.parameters = [
      ...(start.parameters ?? []),
      { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } },
    ];
    api.state.spec = spec;
    const run = await deploy("--idempotency-key", "deploy-42");
    expect(run.code).toBe(0);
    expect(posts().map((request) => [request.path.split("/").pop(), keyOf(request)])).toEqual([
      ["deployments", "deploy-42"],
      ["finalize", undefined],
    ]);
  });
});
