import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { CLI_PATH, cliEnv, FAKE_TOKEN, makeHome, runInProcess } from "../helpers/cli";
import { fakeClock } from "../helpers/fakeApi";
import { PagesApi } from "../helpers/pagesApi";

let api: PagesApi;
let home: Awaited<ReturnType<typeof makeHome>>;
let site: string;
/** The listener the run registered for Ctrl-C, which a test calls to interrupt it. */
let interrupt: (() => void) | undefined;
let listening = 0;

beforeEach(async () => {
  api = new PagesApi({ afterFinalize: ["finalizing", "finalizing", "live"] });
  home = await makeHome();
  site = path.join(await realpath(home.home), "site");
  for (const [name, content] of Object.entries({
    "index.html": "<p>hi</p>",
    "css/site.css": "p{}",
    "img/a.png": "a",
    "img/b.png": "b",
  })) {
    await mkdir(path.dirname(path.join(site, name)), { recursive: true });
    await writeFile(path.join(site, name), content);
  }
  interrupt = undefined;
  listening = 0;
});

afterEach(async () => {
  api.stop();
  await home.cleanup();
});

async function deploy() {
  const run = await runInProcess(
    ["--api-url", api.apiUrl, "labs", "pages", "deployments", "create", "site-1", site],
    {
      env: cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN }),
      clock: fakeClock(Date.now()),
      onInterrupt: (listener) => {
        interrupt = listener;
        listening += 1;
        return () => {
          listening -= 1;
        };
      },
    },
  );
  const errorLine = run.stderr.split("\n").find((line) => line.startsWith("{"));
  return { ...run, error: errorLine ? JSON.parse(errorLine).error : undefined };
}

const cancels = () => api.apiCalls().filter((call) => call.endsWith("/cancel"));

describe("the cancel", () => {
  test("Ctrl-C during the uploads sends one cancel, and the next deploy can start", async () => {
    api.state.storage = async ({ attempt }) => {
      if (attempt === 1) {
        interrupt?.();
        await Bun.sleep(50);
      }
      return new Response(null, { status: 200 });
    };
    const run = await deploy();
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.error.code).toBe("CLI_TASK_FAILED");
    expect(run.error.details).toEqual(
      expect.objectContaining({
        interrupted: true,
        deployment: expect.objectContaining({ id: "dep-1" }),
      }),
    );
    expect(cancels()).toEqual(["POST /v1/labs/pages/sites/site-1/deployments/dep-1/cancel"]);
    expect(api.state.deployments.get("dep-1")?.status).toBe("cancelled");
    expect(api.apiCalls().some((call) => call.endsWith("/finalize"))).toBe(false);
    expect(run.stderr).toContain("cancelled the deployment dep-1");
    expect(listening).toBe(0);

    api.state.storage = undefined;
    const again = await deploy();
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout).deployment.status).toBe("live");
  });

  test("Ctrl-C during the wait sends no cancel, and the deployment still goes live", async () => {
    api.state.onRequest = (request) => {
      if (request.method === "GET" && request.path.endsWith("/deployments/dep-1")) {
        interrupt?.();
      }
    };
    const run = await deploy();
    expect(run.code).toBe(1);
    expect(run.error.code).toBe("CLI_TIMEOUT");
    expect(run.error.details).toEqual(expect.objectContaining({ interrupted: true }));
    expect(cancels()).toEqual([]);
    expect(api.state.deployments.get("dep-1")?.status).not.toBe("cancelled");
  });

  test("a failed upload cancels once, and the storage error stays the error", async () => {
    api.state.storage = ({ path: filePath }) =>
      filePath === "img/a.png"
        ? new Response("<Error><Code>BadDigest</Code></Error>", { status: 400 })
        : undefined;
    const run = await deploy();
    expect(run.code).toBe(1);
    expect(run.error).toEqual(
      expect.objectContaining({
        code: "CLI_BAD_RESPONSE",
        details: { path: "img/a.png", status: 400, storageCode: "BadDigest" },
      }),
    );
    expect(cancels()).toHaveLength(1);
  });

  test("a Ctrl-C during the cancel keeps the first error", async () => {
    api.state.storage = () =>
      new Response("<Error><Code>BadDigest</Code></Error>", { status: 400 });
    api.state.onRequest = (request) => {
      if (request.path.endsWith("/cancel")) {
        interrupt?.();
      }
    };
    const run = await deploy();
    expect(run.error.code).toBe("CLI_BAD_RESPONSE");
    expect(cancels()).toHaveLength(1);
  });

  test("a cancel that fails is reported, and the first error stays", async () => {
    api.state.storage = () => new Response(null, { status: 400 });
    api.state.onRequest = (request) => {
      if (request.path.endsWith("/cancel")) {
        const deployment = api.state.deployments.get("dep-1");
        if (deployment) deployment.status = "finalizing";
      }
    };
    const run = await deploy();
    expect(run.error.code).toBe("CLI_BAD_RESPONSE");
    expect(cancels()).toHaveLength(1);
    expect(run.stderr).toContain("could not be cancelled");
  });

  test("a deploy start whose answer is odd still cancels the deployment it names", async () => {
    api.state.answer = (request) =>
      request.method === "POST" && request.path.endsWith("/deployments")
        ? new Response(JSON.stringify({ deployment: { id: "dep-7", status: "uploading" } }), {
            status: 201,
            headers: { "content-type": "application/json" },
          })
        : undefined;
    const run = await deploy();
    expect(run.error.code).toBe("CLI_BAD_RESPONSE");
    expect(cancels()).toEqual(["POST /v1/labs/pages/sites/site-1/deployments/dep-7/cancel"]);
  });

  test("a failure after finalize sends no cancel", async () => {
    api.state.afterFinalize = ["failed"];
    api.state.failure = "PAGES_UPLOAD_INCOMPLETE";
    const run = await deploy();
    expect(run.code).toBe(1);
    expect(run.error.code).toBe("CLI_TASK_FAILED");
    expect(run.error.details.error).toBe("PAGES_UPLOAD_INCOMPLETE");
    expect(cancels()).toEqual([]);
  });

  test("a real SIGINT to the process cancels the deployment", async () => {
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let killed = false;
    // One SIGINT only: a second one ends the process at once, by design.
    api.state.storage = async () => {
      if (!killed) {
        killed = true;
        child?.kill("SIGINT");
        await Bun.sleep(200);
      }
      return new Response(null, { status: 200 });
    };
    child = Bun.spawn(
      [
        "bun",
        CLI_PATH,
        "--api-url",
        api.apiUrl,
        "labs",
        "pages",
        "deployments",
        "create",
        "site-1",
        site,
      ],
      { env: cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN }), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({
      code: 1,
      stderr: expect.stringContaining('"interrupted":true'),
    });
    expect(stdout).toBe("");
    expect(cancels()).toHaveLength(1);
    expect(api.state.deployments.get("dep-1")?.status).toBe("cancelled");
    expect(
      JSON.parse(stderr.trim().split("\n").at(-1) as string).error.details.deployment.status,
    ).toBe("cancelled");
  }, 30_000);
});
