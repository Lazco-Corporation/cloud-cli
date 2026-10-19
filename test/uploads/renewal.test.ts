import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApiError, CliError } from "../../src/core/errors";
import { Interrupted } from "../../src/uploads/interrupted";
import { type Timer, uploadFiles } from "../../src/uploads/pages/uploadEngine";
import { UploadWindow } from "../../src/uploads/pages/uploadWindow";
import { fakeClock } from "../helpers/fakeApi";
import { FakeStorage, signedUploads, siteFiles } from "../helpers/fakeStorage";

const MINUTE = 60_000;
/** The server's time at the deploy start. */
const SERVER_START = Date.parse("2026-10-19T00:00:00Z");
/** A local clock 30 minutes behind the server. */
const SKEW = 30 * MINUTE;

let root: string;
let storage: FakeStorage;
let clock: ReturnType<typeof fakeClock>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "lazco-renew-")));
  storage = new FakeStorage();
  clock = fakeClock(SERVER_START - SKEW);
});

afterEach(async () => {
  storage.stop();
  await rm(root, { recursive: true, force: true });
});

/** The server's time now, by the fake local clock. */
const serverNow = () => clock.now() + SKEW;

/** A window watch that never wakes, so only the checks around each PUT renew. */
const NEVER: Timer = (_milliseconds, signal) =>
  new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));

type Renewal = { at: number; paths: string[] };

function setUp(files: Awaited<ReturnType<typeof siteFiles>>) {
  const window = new UploadWindow(clock);
  window.update(
    new Date(SERVER_START + 60 * MINUTE).toISOString(),
    new Date(SERVER_START).toUTCString(),
  );
  const renewals: Renewal[] = [];
  let generation = 0;
  const renew = async (paths: string[]) => {
    renewals.push({ at: serverNow(), paths });
    generation += 1;
    window.update(
      new Date(serverNow() + 60 * MINUTE).toISOString(),
      new Date(serverNow()).toUTCString(),
    );
    const named = new Map([...files].filter(([filePath]) => paths.includes(filePath)));
    return signedUploads(storage, named, generation);
  };
  return { window, renewals, renew };
}

function generationOf(url: string): string | null {
  return new URL(url).searchParams.get("generation");
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("the renewal", () => {
  test("fires 10 minutes before the end by the server's time, with a local clock 30 minutes wrong", async () => {
    const contents: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) {
      contents[`f${index}.bin`] = `file ${index}`;
    }
    const files = await siteFiles(root, contents);
    const { window, renewals, renew } = setUp(files);
    // Each PUT takes 7 minutes, one at a time.
    storage.handler = () => {
      clock.time += 7 * MINUTE;
      return new Response(null, { status: 200 });
    };
    await uploadFiles({
      uploads: signedUploads(storage, files),
      files,
      lastExtensions: new Set(["html"]),
      window,
      renew,
      fetch,
      clock,
      signal: new AbortController().signal,
      concurrency: 1,
      timer: NEVER,
    });
    // 8 PUTs end 56 minutes in, 4 minutes before the end: the 9th waits for one renewal.
    expect(renewals).toEqual([{ at: SERVER_START + 56 * MINUTE, paths: ["f8.bin", "f9.bin"] }]);
    expect(storage.puts.map((put) => generationOf(put.url))).toEqual([
      ..."00000000".split(""),
      "1",
      "1",
    ]);
  });

  test("a PUT still running keeps its URL, and the window watch renews for it", async () => {
    const files = await siteFiles(root, { "big.bin": "big" });
    const { window, renewals, renew } = setUp(files);
    let renewed: () => void = () => {};
    const renewalSeen = new Promise<void>((resolve) => {
      renewed = resolve;
    });
    storage.handler = async () => {
      clock.time += 55 * MINUTE;
      await renewalSeen;
      return new Response(null, { status: 200 });
    };
    const result = await uploadFiles({
      uploads: signedUploads(storage, files),
      files,
      lastExtensions: new Set(["html"]),
      window,
      renew: async (paths) => {
        const answer = await renew(paths);
        renewed();
        return answer;
      },
      fetch,
      clock,
      signal: new AbortController().signal,
      timer: () => new Promise((resolve) => setTimeout(resolve, 5)),
    });
    expect(result.uploaded).toBe(1);
    expect(renewals).toEqual([{ at: SERVER_START + 55 * MINUTE, paths: [] }]);
    expect(storage.puts.map((put) => generationOf(put.url))).toEqual(["0"]);
    expect(window.remainingMs()).toBe(60 * MINUTE);
  });

  test("a short window after the last PUT is renewed with no path before finalize", async () => {
    const files = await siteFiles(root, { "index.html": "<p>" });
    const { window, renewals, renew } = setUp(files);
    storage.handler = () => {
      clock.time += 52 * MINUTE;
      return new Response(null, { status: 200 });
    };
    await uploadFiles({
      uploads: signedUploads(storage, files),
      files,
      lastExtensions: new Set(["html"]),
      window,
      renew,
      fetch,
      clock,
      signal: new AbortController().signal,
      timer: NEVER,
    });
    expect(renewals).toEqual([{ at: SERVER_START + 52 * MINUTE, paths: [] }]);
  });

  test("a 403 renews once and sends the file again with its new URL", async () => {
    const files = await siteFiles(root, { "site.css": "p{}", "a.png": "a" });
    const { window, renewals, renew } = setUp(files);
    storage.handler = (put) =>
      new Response(null, { status: put.path === "site.css" && put.attempt === 1 ? 403 : 200 });
    await uploadFiles({
      uploads: signedUploads(storage, files),
      files,
      lastExtensions: new Set(["html"]),
      window,
      renew,
      fetch,
      clock,
      signal: new AbortController().signal,
      concurrency: 1,
      timer: NEVER,
    });
    expect(renewals.map((renewal) => renewal.paths.sort())).toEqual([["a.png", "site.css"]]);
    const css = storage.puts.filter((put) => put.path === "site.css");
    expect(css.map((put) => generationOf(put.url))).toEqual(["0", "1"]);
  });

  test("a second 403 fails with CLI_BAD_RESPONSE", async () => {
    const files = await siteFiles(root, { "site.css": "p{}" });
    const { window, renewals, renew } = setUp(files);
    storage.handler = () =>
      new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    const error = await failure(
      uploadFiles({
        uploads: signedUploads(storage, files),
        files,
        lastExtensions: new Set(["html"]),
        window,
        renew,
        fetch,
        clock,
        signal: new AbortController().signal,
        timer: NEVER,
      }),
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("CLI_BAD_RESPONSE");
    expect((error as CliError).details).toEqual({
      path: "site.css",
      status: 403,
      storageCode: "AccessDenied",
    });
    expect(renewals).toHaveLength(1);
    expect(storage.puts).toHaveLength(2);
  });

  test("three PUTs refused at once each get a new URL, whichever renewal they wait on", async () => {
    const files = await siteFiles(root, { "a.png": "a", "b.png": "b", "c.png": "c" });
    const { window, renewals, renew } = setUp(files);
    storage.handler = async (put) => {
      if (put.attempt === 1) {
        // b and c are refused while the renewal for a is in flight, so both wait on one that lacks them.
        await Bun.sleep({ "a.png": 0, "b.png": 5, "c.png": 10 }[put.path] ?? 0);
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 200 });
    };
    const result = await uploadFiles({
      uploads: signedUploads(storage, files),
      files,
      lastExtensions: new Set(["html"]),
      window,
      renew: async (paths) => {
        await Bun.sleep(40);
        return renew(paths);
      },
      fetch,
      clock,
      signal: new AbortController().signal,
      timer: NEVER,
    });
    expect(result.uploaded).toBe(3);
    expect(renewals.flatMap((renewal) => renewal.paths).sort()).toEqual([
      "a.png",
      "b.png",
      "c.png",
    ]);
    for (const name of ["a.png", "b.png", "c.png"]) {
      const puts = storage.puts.filter((put) => put.path === name);
      expect(puts.map((put) => put.attempt)).toEqual([1, 2]);
      expect(generationOf(puts[1]?.url as string)).not.toBe("0");
    }
  });

  test("a renewal with no answer is sent again while the window is open", async () => {
    const files = await siteFiles(root, { "site.css": "p{}" });
    const { window, renewals, renew } = setUp(files);
    storage.handler = (put) => new Response(null, { status: put.attempt === 1 ? 403 : 200 });
    let failures = 2;
    const result = await uploadFiles({
      uploads: signedUploads(storage, files),
      files,
      lastExtensions: new Set(["html"]),
      window,
      renew: async (paths) => {
        if (failures > 0) {
          failures -= 1;
          throw new CliError("CLI_NETWORK", "The API could not be reached");
        }
        return renew(paths);
      },
      fetch,
      clock,
      signal: new AbortController().signal,
      timer: NEVER,
    });
    expect(result.uploaded).toBe(1);
    expect(renewals).toHaveLength(1);
    expect(failures).toBe(0);
  });

  test("a renewal that keeps failing ends the upload after 3 retries", async () => {
    const files = await siteFiles(root, { "site.css": "p{}" });
    const { window } = setUp(files);
    storage.handler = () => new Response(null, { status: 403 });
    let calls = 0;
    const error = await failure(
      uploadFiles({
        uploads: signedUploads(storage, files),
        files,
        lastExtensions: new Set(["html"]),
        window,
        renew: async () => {
          calls += 1;
          throw new ApiError(503, "SERVICE_UNAVAILABLE", "Unavailable", {});
        },
        fetch,
        clock,
        signal: new AbortController().signal,
        timer: NEVER,
      }),
    );
    expect(error).toEqual(expect.objectContaining({ status: 503 }));
    expect(calls).toBe(4);
  });

  test("a retry late in the window renews the started file first", async () => {
    const files = await siteFiles(root, { "a.png": "a" });
    const { window, renewals, renew } = setUp(files);
    storage.handler = (put) => {
      if (put.attempt === 1) {
        clock.time += 52 * MINUTE;
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 200 });
    };
    await uploadFiles({
      uploads: signedUploads(storage, files),
      files,
      lastExtensions: new Set(["html"]),
      window,
      renew,
      fetch,
      clock,
      signal: new AbortController().signal,
      timer: NEVER,
    });
    expect(renewals.map((renewal) => renewal.paths)).toEqual([["a.png"]]);
    expect(storage.puts.map((put) => generationOf(put.url))).toEqual(["0", "1"]);
  });

  test("a retry waits out a renewal of other paths, then renews its own old URL", async () => {
    const files = await siteFiles(root, { "a.png": "a", "b.png": "b", "c.png": "c" });
    const { window, renewals, renew } = setUp(files);
    let advanced: () => void = () => {};
    const clockMoved = new Promise<void>((resolve) => {
      advanced = resolve;
    });
    storage.handler = async (put) => {
      if (put.path === "a.png") {
        // a ends only after b moved the clock, so its worker starts c late in the window.
        await clockMoved;
        return new Response(null, { status: 200 });
      }
      if (put.path === "b.png" && put.attempt === 1) {
        clock.time += 52 * MINUTE;
        advanced();
        await Bun.sleep(5);
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 200 });
    };
    await uploadFiles({
      uploads: signedUploads(storage, files),
      files,
      lastExtensions: new Set(["html"]),
      window,
      renew: async (paths) => {
        await Bun.sleep(30);
        return renew(paths);
      },
      fetch,
      clock,
      signal: new AbortController().signal,
      concurrency: 2,
      timer: NEVER,
    });
    expect(renewals).toHaveLength(2);
    expect(renewals[0]?.paths).toEqual(["c.png"]);
    expect(renewals[1]?.paths).toContain("b.png");
    // The retry of b carries the URL of the second renewal, never its first one.
    const b = storage.puts.filter((put) => put.path === "b.png");
    expect(b.map((put) => generationOf(put.url))).toEqual(["0", "2"]);
  });

  test("an interrupt while a renewal is in flight starts no other PUT", async () => {
    const files = await siteFiles(root, { "a.png": "a", "b.png": "b" });
    const { window, renew } = setUp(files);
    storage.handler = (put) => new Response(null, { status: put.attempt === 1 ? 403 : 200 });
    const controller = new AbortController();
    const error = await failure(
      uploadFiles({
        uploads: signedUploads(storage, files),
        files,
        lastExtensions: new Set(["html"]),
        window,
        renew: async (paths) => {
          controller.abort();
          return renew(paths);
        },
        fetch,
        clock,
        signal: controller.signal,
        concurrency: 1,
        timer: NEVER,
      }),
    );
    expect(error).toBeInstanceOf(Interrupted);
    expect(storage.puts.map((put) => put.path)).toEqual(["a.png"]);
  });

  test("PAGES_UPLOAD_EXPIRED from the renewal ends the upload as that server error", async () => {
    const files = await siteFiles(root, { "site.css": "p{}" });
    const { window } = setUp(files);
    storage.handler = () => new Response(null, { status: 403 });
    const expired = new ApiError(409, "PAGES_UPLOAD_EXPIRED", "The upload window ended", {
      uploadExpiresAt: "2026-10-19T01:00:00.000Z",
    });
    const error = await failure(
      uploadFiles({
        uploads: signedUploads(storage, files),
        files,
        lastExtensions: new Set(["html"]),
        window,
        renew: async () => {
          throw expired;
        },
        fetch,
        clock,
        signal: new AbortController().signal,
        timer: NEVER,
      }),
    );
    expect(error).toBe(expired);
    expect(storage.puts).toHaveLength(1);
  });

  test("the window end comes from uploadExpiresAt and Date, not the local clock", () => {
    const window = new UploadWindow(clock);
    window.update(
      new Date(SERVER_START + 60 * MINUTE).toISOString(),
      new Date(SERVER_START).toUTCString(),
    );
    expect(window.remainingMs()).toBe(60 * MINUTE);
    clock.time += 50 * MINUTE + 1;
    expect(window.needsRenewal()).toBe(true);
  });
});
