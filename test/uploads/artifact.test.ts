import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { KNOWN_UPLOADERS } from "../../src/core/generate/annotation";
import { generateSurface, type Operation } from "../../src/core/generate/operations";
import { createAjv } from "../../src/core/request/ajv";
import { selectTools } from "../../src/mcp/tools";
import { operationEntry } from "../../src/shell/entries";
import { buildInput } from "../../src/shell/input";
import { MAX_ARTIFACT_BYTES, MAX_ARTIFACT_FILES } from "../../src/uploads/artifacts/files";
import { UPLOADERS } from "../../src/uploads/registry";
import { ARTIFACT_WARNING, ArtifactsApi, artifactAnswer } from "../helpers/artifactsApi";
import { cliEnv, FAKE_TOKEN, makeHome, runInProcess } from "../helpers/cli";
import { fakeClock } from "../helpers/fakeApi";
import { loadFixture } from "../helpers/fixtures";
import { type ConnectedSession, connectSession, resultJson } from "../helpers/mcp";

const ajv = createAjv();
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

let api: ArtifactsApi;
let home: Awaited<ReturnType<typeof makeHome>>;
let root: string;
let connected: ConnectedSession | undefined;

async function writeTree(at: string, contents: Record<string, string | Buffer>): Promise<void> {
  for (const [name, content] of Object.entries(contents)) {
    await mkdir(path.dirname(path.join(at, name)), { recursive: true });
    await writeFile(path.join(at, name), content);
  }
}

beforeEach(async () => {
  api = new ArtifactsApi();
  home = await makeHome();
  root = path.join(await realpath(home.home), "work");
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await connected?.close();
  connected = undefined;
  api.stop();
  await home.cleanup();
});

function lazco(...args: string[]) {
  return runInProcess(["--api-url", api.apiUrl, "labs", "artifacts", ...args], {
    env: cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN }),
    clock: fakeClock(Date.now()),
  });
}

function operation(command: string): Operation {
  const found = generateSurface(loadFixture("artifacts"), ajv).operations.find(
    (candidate) => candidate.command.join(" ") === command,
  );
  if (!found) {
    throw new Error(`no command ${command}`);
  }
  return found;
}

function errorOf(stderr: string): { code: string; message: string; details?: unknown } {
  const line = stderr
    .trim()
    .split("\n")
    .find((text) => text.startsWith('{"error"'));
  return JSON.parse(line ?? "null").error;
}

describe("the uploader artifact", () => {
  test("every known uploader has its code", () => {
    expect([...UPLOADERS.keys()].sort()).toEqual([...KNOWN_UPLOADERS.keys()].sort());
    expect(KNOWN_UPLOADERS.has("artifact")).toBe(true);
  });

  test("the publish takes path in place of files, and keeps the other body fields", () => {
    const publish = operation("labs artifacts publish");
    expect(publish.body).toEqual({
      mode: "upload",
      uploader: "artifact",
      bodyInputs: ["region", "title", "projectId", "files"],
    });
    expect(publish.toolName).toBe("labs_artifacts_publish");
    expect(publish.feature).toBe("artifacts");
    expect(publish.positionals).toEqual(["path"]);
    expect(Object.keys(publish.inputSchema.properties as object).sort()).toEqual([
      "files",
      "path",
      "projectId",
      "region",
      "title",
    ]);
    expect(publish.inputSchema.required).toEqual(["region", "title"]);
    expect(publish.inputSchema.additionalProperties).toBe(false);
  });

  test("the update takes the id, then path, and ifMatch", () => {
    const update = operation("labs artifacts update");
    expect(update.body).toEqual({
      mode: "upload",
      uploader: "artifact",
      bodyInputs: ["title", "files"],
    });
    expect(update.positionals).toEqual(["id", "path"]);
    expect(Object.keys(update.inputSchema.properties as object).sort()).toEqual([
      "files",
      "id",
      "ifMatch",
      "path",
      "title",
    ]);
    expect(update.inputSchema.required).toEqual(["id"]);
  });

  test("the command line gives path as a positional and the fields as flags", () => {
    const entry = operationEntry(operation("labs artifacts publish"));
    expect(
      buildInput({
        schema: entry.inputSchema,
        positionals: entry.positionals,
        tokens: ["./report", "--region", "tw-tpe", "--title", "Report", "--project-id", "p-1"],
        payload: undefined,
      }),
    ).toEqual({ path: "./report", region: "tw-tpe", title: "Report", projectId: "p-1" });
  });

  test("the tools carry the uploader's notes", () => {
    const { tools } = selectTools(generateSurface(loadFixture("artifacts"), ajv).operations, {
      allowWrites: true,
      allowSpend: false,
      facts: {
        organization: { id: "org-1", name: "Org" },
        scope: "read_write",
        features: { artifacts: true },
      },
    });
    const publish = tools.find((tool) => tool.name === "labs_artifacts_publish");
    expect(publish?.description).toContain("Give either path");
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "labs_artifacts_get",
      "labs_artifacts_publish",
      "labs_artifacts_update",
    ]);
  });

  test("an upload body that is no object skips the operation", () => {
    const spec = loadFixture("artifacts");
    const post = spec.paths["/v1/labs/artifacts"]?.post as {
      requestBody: { content: Record<string, { schema: unknown }> };
    };
    post.requestBody.content["application/json"] = { schema: { type: "array" } };
    const { skipped } = generateSurface(spec, ajv);
    expect(skipped.map((skip) => [skip.operationId, skip.reason])).toEqual([
      ["labs.artifacts.publish", "unsupported-body"],
    ]);
  });
});

describe("a publish from a local path", () => {
  test("a directory sends every file with its path from the directory, and skips dotfiles", async () => {
    await writeTree(root, {
      "index.html": "<link href=css/site.css><img src=img/logo.png>",
      "css/site.css": "body{color:red}",
      "img/logo.png": PNG_BYTES,
      "img/icon.svg": "<svg/>",
      "fonts/a.woff2": PNG_BYTES,
      ".env": "SECRET=1",
      ".git/config": "[core]",
      "img/.DS_Store": "x",
    });
    const run = await lazco("publish", root, "--region", "tw-tpe", "--title", "Report");
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(artifactAnswer("ver-1"));
    expect(run.stderr).toContain("lazco: found 5 files");
    expect(run.stderr).toContain("skipped 3: .env, .git, img/.DS_Store");
    expect(run.stderr).toContain("1 thing in the content will not work");
    expect(api.calls()).toEqual(["POST /v1/labs/artifacts"]);
    const body = api.written();
    expect(body.region).toBe("tw-tpe");
    expect(body.title).toBe("Report");
    expect(body.projectId).toBeUndefined();
    expect(body.files).toEqual([
      { path: "css/site.css", encoding: "utf-8", content: "body{color:red}" },
      { path: "fonts/a.woff2", encoding: "base64", content: PNG_BYTES.toString("base64") },
      { path: "img/icon.svg", encoding: "utf-8", content: "<svg/>" },
      { path: "img/logo.png", encoding: "base64", content: PNG_BYTES.toString("base64") },
      {
        path: "index.html",
        encoding: "utf-8",
        content: "<link href=css/site.css><img src=img/logo.png>",
      },
    ]);
  });

  test("a single file is sent under its own name, from a relative path too", async () => {
    await writeTree(root, { "notes/report.md": "# Report\n\n```mermaid\ngraph TD\n```\n" });
    const run = await runInProcess(
      [
        "--api-url",
        api.apiUrl,
        "labs",
        "artifacts",
        "publish",
        path.relative(process.cwd(), path.join(root, "notes", "report.md")),
        "--region",
        "tw-tpe",
        "--title",
        "Report",
        "--project-id",
        "prj-1",
      ],
      { env: cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN }), clock: fakeClock(Date.now()) },
    );
    expect(run.code).toBe(0);
    const body = api.written();
    expect(body.projectId).toBe("prj-1");
    expect(body.files).toEqual([
      { path: "report.md", encoding: "utf-8", content: "# Report\n\n```mermaid\ngraph TD\n```\n" },
    ]);
  });

  test("the answer and its warnings print unchanged", async () => {
    await writeTree(root, { "index.html": "<p>hi</p>" });
    const run = await lazco("publish", root, "--region", "tw-tpe", "--title", "Report");
    expect(run.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(run.stdout).warnings).toEqual([ARTIFACT_WARNING]);
  });

  test("--dry-run reads and checks the files and sends nothing", async () => {
    await writeTree(root, { "index.html": "<p>hi</p>" });
    const run = await lazco(
      "publish",
      root,
      "--region",
      "tw-tpe",
      "--title",
      "Report",
      "--dry-run",
    );
    expect(run.code).toBe(0);
    const preview = JSON.parse(run.stdout);
    expect(preview.dryRun).toBe(true);
    expect(preview.method).toBe("POST");
    expect(preview.body.files).toEqual([
      { path: "index.html", encoding: "utf-8", contentLength: 9 },
    ]);
    expect(api.calls()).toEqual([]);
  });

  test("an API error passes through with its code", async () => {
    await writeTree(root, { "index.html": "<p>hi</p>" });
    api.answer = (request) =>
      request.method === "POST"
        ? new Response(
            JSON.stringify({
              error: "A secret is in index.html",
              code: "ARTIFACT_SECRET_DETECTED",
              file: "index.html",
              line: 1,
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          )
        : undefined;
    const run = await lazco("publish", root, "--region", "tw-tpe", "--title", "Report");
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(errorOf(run.stderr)).toMatchObject({ code: "ARTIFACT_SECRET_DETECTED", line: 1 });
  });
});

describe("the limits are checked before anything is sent", () => {
  async function refused(...args: string[]) {
    const run = await lazco("publish", ...args, "--region", "tw-tpe", "--title", "Report");
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(api.calls()).toEqual([]);
    return errorOf(run.stderr);
  }

  test(`more than ${MAX_ARTIFACT_FILES} files`, async () => {
    const files: Record<string, string> = { "index.html": "<p>hi</p>" };
    for (let index = 0; index < MAX_ARTIFACT_FILES; index += 1) {
      files[`css/${index}.css`] = "p{}";
    }
    await writeTree(root, files);
    const error = await refused(root);
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.message).toContain(`at most ${MAX_ARTIFACT_FILES} files`);
  });

  test("exactly the file limit is sent", async () => {
    const files: Record<string, string> = { "index.html": "<p>hi</p>" };
    for (let index = 1; index < MAX_ARTIFACT_FILES; index += 1) {
      files[`css/${index}.css`] = "p{}";
    }
    await writeTree(root, files);
    const run = await lazco("publish", root, "--region", "tw-tpe", "--title", "Report");
    expect(run.code).toBe(0);
    expect(api.written().files).toHaveLength(MAX_ARTIFACT_FILES);
  });

  test("more than 5 MiB in total", async () => {
    await writeTree(root, {
      "index.html": "<img src=a.png>",
      "a.png": Buffer.alloc(MAX_ARTIFACT_BYTES),
    });
    const error = await refused(root);
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.message).toContain("at most 5.0 MiB");
  });

  test("a type a publish may not hold", async () => {
    await writeTree(root, { "index.html": "<p>hi</p>", "app.js": "alert(1)" });
    const error = await refused(root);
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.message).toContain("app.js");
  });

  test("a text file that is not UTF-8", async () => {
    await writeTree(root, { "index.html": Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe]) });
    const error = await refused(root);
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.message).toContain("not valid UTF-8");
  });

  test("a link inside the directory", async () => {
    await writeTree(root, { "index.html": "<p>hi</p>", "../outside.css": "p{}" });
    await symlink(path.join(root, "..", "outside.css"), path.join(root, "site.css"));
    const error = await refused(root);
    expect(error.message).toContain("site.css is a link");
  });

  test("a missing path, the home directory and a directory of dotfiles only", async () => {
    expect((await refused(path.join(root, "nothing"))).message).toContain("does not exist");
    expect((await refused(home.home)).message).toContain("home directory");
    await writeTree(root, { ".hidden.html": "<p>hi</p>" });
    expect((await refused(root)).message).toContain("holds no file to publish");
  });

  test("neither path nor files", async () => {
    const error = await refused();
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.message).toContain("Give either path");
  });
});

describe("an update", () => {
  test("with no ifMatch, reads the current ETag first and sends it as If-Match", async () => {
    await writeTree(root, { "index.html": "<p>new</p>" });
    const run = await lazco("update", "art-1", root, "--title", "Report 2");
    expect(run.code).toBe(0);
    expect(api.calls()).toEqual(["GET /v1/labs/artifacts/art-1", "PUT /v1/labs/artifacts/art-1"]);
    const [read, write] = api.requests.filter((request) => request.path.endsWith("/art-1"));
    expect(read?.headers["accept-encoding"]).toBe("identity");
    expect(write?.headers["if-match"]).toBe('"ver-1"');
    expect(api.written()).toEqual({
      title: "Report 2",
      files: [{ path: "index.html", encoding: "utf-8", content: "<p>new</p>" }],
    });
    expect(JSON.parse(run.stdout).versionId).toBe("ver-2");
  });

  test("with ifMatch, sends it with no read, and a stale one is the API's 409", async () => {
    await writeTree(root, { "index.html": "<p>new</p>" });
    const run = await lazco("update", "art-1", root, "--if-match", "ver-0");
    expect(run.code).toBe(1);
    expect(api.calls()).toEqual(["PUT /v1/labs/artifacts/art-1"]);
    expect(api.requests.at(-1)?.headers["if-match"]).toBe('"ver-0"');
    expect(errorOf(run.stderr).code).toBe("ARTIFACT_VERSION_CONFLICT");
  });

  test("--dry-run names the ETag read it would send", async () => {
    await writeTree(root, { "index.html": "<p>new</p>" });
    const run = await lazco("update", "art-1", root, "--dry-run");
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).ifMatchFrom).toMatchObject({
      method: "GET",
      headers: { "Accept-Encoding": "identity" },
    });
    expect(api.calls()).toEqual([]);
  });
});

describe("the MCP tools", () => {
  async function connect() {
    connected = await connectSession(api, {
      allowWrites: true,
      cacheDirectory: home.cache,
      clock: fakeClock(Date.now()),
    });
    return connected;
  }

  test("a publish takes files directly, for content that is in no file", async () => {
    const session = await connect();
    const files = [{ path: "report.md", encoding: "utf-8", content: "# Report" }];
    const result = await session.client.callTool({
      name: "labs_artifacts_publish",
      arguments: { region: "tw-tpe", title: "Report", files },
    });
    expect(result.isError).toBeFalsy();
    expect(resultJson(result)).toEqual(artifactAnswer("ver-1"));
    expect(api.written()).toEqual({ region: "tw-tpe", title: "Report", files });
  });

  test("a publish takes an absolute path, and refuses a relative one", async () => {
    await writeTree(root, { "index.html": "<p>hi</p>" });
    const session = await connect();
    const relative = await session.client.callTool({
      name: "labs_artifacts_publish",
      arguments: { region: "tw-tpe", title: "Report", path: "work" },
    });
    expect(relative.isError).toBe(true);
    expect(JSON.stringify(resultJson(relative))).toContain("absolute path");
    const absolute = await session.client.callTool({
      name: "labs_artifacts_publish",
      arguments: { region: "tw-tpe", title: "Report", path: root },
    });
    expect(absolute.isError).toBeFalsy();
    expect(api.written().files).toEqual([
      { path: "index.html", encoding: "utf-8", content: "<p>hi</p>" },
    ]);
  });

  test("path and files together, and files over the limits, are refused before any request", async () => {
    await writeTree(root, { "index.html": "<p>hi</p>" });
    const session = await connect();
    const both = await session.client.callTool({
      name: "labs_artifacts_publish",
      arguments: {
        region: "tw-tpe",
        title: "Report",
        path: root,
        files: [{ path: "a.md", encoding: "utf-8", content: "a" }],
      },
    });
    expect(both.isError).toBe(true);
    const tooLarge = await session.client.callTool({
      name: "labs_artifacts_publish",
      arguments: {
        region: "tw-tpe",
        title: "Report",
        files: [
          {
            path: "a.png",
            encoding: "base64",
            content: Buffer.alloc(MAX_ARTIFACT_BYTES + 1).toString("base64"),
          },
        ],
      },
    });
    expect(tooLarge.isError).toBe(true);
    expect(JSON.stringify(resultJson(tooLarge))).toContain("CLI_INVALID_INPUT");
    expect(api.calls()).toEqual([]);
  });

  test("an update reads the ETag first", async () => {
    const session = await connect();
    const result = await session.client.callTool({
      name: "labs_artifacts_update",
      arguments: { id: "art-1", files: [{ path: "index.md", encoding: "utf-8", content: "# 2" }] },
    });
    expect(result.isError).toBeFalsy();
    expect(api.calls()).toEqual(["GET /v1/labs/artifacts/art-1", "PUT /v1/labs/artifacts/art-1"]);
  });
});
