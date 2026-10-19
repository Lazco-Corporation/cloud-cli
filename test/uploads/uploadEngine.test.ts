import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliError } from "../../src/core/errors";
import { putDeadlineMs, uploadFiles } from "../../src/uploads/pages/uploadEngine";
import { UploadWindow } from "../../src/uploads/pages/uploadWindow";
import { fakeClock } from "../helpers/fakeApi";
import { FakeStorage, signedUploads, siteFiles } from "../helpers/fakeStorage";

let root: string;
let storage: FakeStorage;
const clock = fakeClock(Date.parse("2026-10-19T00:00:00Z"));

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "lazco-engine-")));
  storage = new FakeStorage();
});

afterEach(async () => {
  storage.stop();
  await rm(root, { recursive: true, force: true });
});

function openWindow(): UploadWindow {
  const window = new UploadWindow(clock);
  window.update(
    new Date(clock.now() + 3600_000).toISOString(),
    new Date(clock.now()).toUTCString(),
  );
  return window;
}

function run(
  files: Awaited<ReturnType<typeof siteFiles>>,
  overrides: Partial<Parameters<typeof uploadFiles>[0]> = {},
) {
  return uploadFiles({
    uploads: signedUploads(storage, files),
    files,
    lastExtensions: new Set(["html", "htm", "xhtml"]),
    window: openWindow(),
    renew: async () => {
      throw new Error("no renewal expected");
    },
    fetch,
    clock,
    signal: new AbortController().signal,
    ...overrides,
  });
}

async function failure(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a CliError");
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("the upload engine", () => {
  test("each PUT sends the file bytes with exactly the signed headers, and no credential", async () => {
    const files = await siteFiles(root, { "img/logo.png": "png-bytes", "index.html": "<p>" });
    const result = await run(files);
    expect(result).toEqual({ uploaded: 2, uploadedBytes: 12 });
    for (const put of storage.puts) {
      const { file, sha256 } = files.get(put.path) as NonNullable<ReturnType<typeof files.get>>;
      expect(put.bytes).toBe(file.size);
      expect(put.headers["content-length"]).toBe(String(file.size));
      expect(put.headers["content-type"]).toBe("application/octet-stream");
      expect(put.headers["x-amz-checksum-sha256"]).toBe(
        Buffer.from(sha256, "hex").toString("base64"),
      );
      expect(put.headers.authorization).toBeUndefined();
      expect(put.headers["transfer-encoding"]).toBeUndefined();
    }
  });

  test("no last file starts before every other file succeeded", async () => {
    const contents: Record<string, string> = { "index.html": "<p>", "about/index.htm": "<p>" };
    for (let index = 0; index < 20; index += 1) {
      contents[`img/${index}.png`] = `image ${index}`;
    }
    const files = await siteFiles(root, contents);
    storage.handler = async (put) => {
      await sleep(put.path.endsWith("19.png") ? 60 : 5);
      return new Response(null, { status: 200 });
    };
    await run(files);
    const firstLastStart = storage.events.findIndex(
      (event) => event.startsWith("start ") && /\.html?$/.test(event),
    );
    const lastOtherEnd = storage.events.findLastIndex(
      (event) => event.startsWith("end ") && event.endsWith(".png"),
    );
    expect(firstLastStart).toBeGreaterThan(lastOtherEnd);
    expect(storage.puts).toHaveLength(22);
  });

  test("at most 8 PUTs run at once", async () => {
    const contents: Record<string, string> = {};
    for (let index = 0; index < 30; index += 1) {
      contents[`f${index}.bin`] = `file ${index}`;
    }
    storage.handler = async () => {
      await sleep(20);
      return new Response(null, { status: 200 });
    };
    await run(await siteFiles(root, contents));
    expect(storage.maxInFlight).toBe(8);
  });

  test("a file changed after hashing fails by name, and is never sent", async () => {
    const files = await siteFiles(root, { "app.js": "built once" });
    // Same size, other bytes: only the hash before the PUT can tell.
    await writeFile(path.join(root, "app.js"), "built ONCE");
    const error = await failure(run(files));
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.details).toEqual({ path: "app.js" });
    expect(storage.puts).toHaveLength(0);
  });

  test("a 503 then a 200 succeeds", async () => {
    const files = await siteFiles(root, { "a.png": "a" });
    storage.handler = (put) => new Response(null, { status: put.attempt === 1 ? 503 : 200 });
    expect(await run(files)).toEqual({ uploaded: 1, uploadedBytes: 1 });
    expect(storage.puts.map((put) => put.attempt)).toEqual([1, 2]);
  });

  test("a storage refusal after 3 retries is CLI_BAD_RESPONSE with the path and status", async () => {
    const files = await siteFiles(root, { "a.png": "a" });
    storage.handler = () =>
      new Response("<Error><Code>SlowDown</Code></Error>", {
        status: 503,
        headers: { "content-type": "application/xml" },
      });
    const error = await failure(run(files));
    expect(error.code).toBe("CLI_BAD_RESPONSE");
    expect(error.details).toEqual({ path: "a.png", status: 503, storageCode: "SlowDown" });
    expect(storage.puts).toHaveLength(4);
  });

  test("a 4xx other than 403 is not tried again", async () => {
    const files = await siteFiles(root, { "a.png": "a" });
    storage.handler = () => new Response("<Error><Code>BadDigest</Code></Error>", { status: 400 });
    const error = await failure(run(files));
    expect(error.code).toBe("CLI_BAD_RESPONSE");
    expect(error.details).toEqual({ path: "a.png", status: 400, storageCode: "BadDigest" });
    expect(storage.puts).toHaveLength(1);
  });

  test("no answer after 3 retries is CLI_NETWORK", async () => {
    const files = await siteFiles(root, { "a.png": "a" });
    const unreachable = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const url = `http://127.0.0.1:${unreachable.port}/a.png`;
    unreachable.stop(true);
    const error = await failure(
      run(files, {
        uploads: signedUploads(storage, files).map((upload) => ({ ...upload, url })),
      }),
    );
    expect(error.code).toBe("CLI_NETWORK");
    expect((error.details as { path: string }).path).toBe("a.png");
  });

  test("a PUT past its deadline is tried again, then CLI_NETWORK", async () => {
    const files = await siteFiles(root, { "a.png": "a" });
    storage.handler = async () => {
      await sleep(300);
      return new Response(null, { status: 200 });
    };
    const error = await failure(run(files, { deadlineMs: () => 30 }));
    expect(error.code).toBe("CLI_NETWORK");
    expect(error.message).toContain("did not finish");
    expect(storage.puts.length).toBe(4);
  });

  test("the deadline is 30 seconds plus one second for each 32 KiB", () => {
    expect(putDeadlineMs(0)).toBe(30_000);
    expect(putDeadlineMs(32 * 1024)).toBe(31_000);
    expect(putDeadlineMs(25 * 1024 * 1024)).toBe(30_000 + 800_000);
  });

  test("an upload the deploy does not hold is CLI_BAD_RESPONSE before any PUT", async () => {
    const files = await siteFiles(root, { "a.png": "a" });
    const error = await failure(
      run(files, {
        uploads: [{ path: "other.png", url: storage.url("other.png"), headers: {} }],
      }),
    );
    expect(error.code).toBe("CLI_BAD_RESPONSE");
    expect(storage.puts).toHaveLength(0);
  });
});
