import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "../../src/core/errors";
import { ApiClient } from "../../src/core/request/client";
import { RateLimiter } from "../../src/core/request/rateLimiter";
import { SPEC_FRESH_MS, SpecSource } from "../../src/core/spec/loader";
import { staticCredential } from "../../src/credentials/credential";
import { closedApiUrl, FakeApi, fakeClock, json } from "../helpers/fakeApi";
import { loadFixture } from "../helpers/fixtures";

let cacheDirectory: string;
let api: FakeApi;
const spec = loadFixture("surface");

beforeEach(async () => {
  cacheDirectory = await mkdtemp(join(tmpdir(), "lazco-spec-"));
  api = new FakeApi((request) => {
    if (request.headers["if-none-match"] === '"v1"') {
      return new Response(null, { status: 304, headers: { etag: '"v1"' } });
    }
    return json(200, spec, { etag: '"v1"' });
  });
});

afterEach(async () => {
  api.stop();
  await rm(cacheDirectory, { recursive: true, force: true });
});

function source(apiUrl: string, clock = fakeClock()) {
  const warnings: string[] = [];
  const client = new ApiClient({
    apiUrl,
    userAgent: "lazco-cli/test",
    credential: staticCredential(
      "lz_live_000000000000000000000000000000000000000000000000aaaaaaaaaaaaaaaa",
    ),
    limiter: new RateLimiter(clock),
    clock,
  });
  const specSource = new SpecSource({
    client,
    cacheDirectory,
    clock,
    warn: (message) => warnings.push(message),
  });
  return { specSource, warnings, clock };
}

async function seedCache(path: string, apiUrl: string, checkedAt: number, etag = '"v1"') {
  await Bun.write(path, JSON.stringify({ apiUrl, etag, checkedAt, spec }));
}

describe("spec loader", () => {
  test("no cache gets the spec without a credential and caches it with its ETag", async () => {
    const { specSource, clock } = source(api.apiUrl);
    const loaded = await specSource.get();
    expect(loaded.origin).toBe("network");
    expect(loaded.etag).toBe('"v1"');
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.path).toBe("/v1/spec");
    expect(api.requests[0]?.headers.authorization).toBeUndefined();
    const cached = JSON.parse(await readFile(specSource.cachePath, "utf8"));
    expect(cached).toMatchObject({ apiUrl: api.apiUrl, etag: '"v1"', checkedAt: clock.time });
    expect(dirname(specSource.cachePath)).toBe(join(cacheDirectory, "spec"));
  });

  test("a fresh cache sends nothing", async () => {
    const { specSource, clock } = source(api.apiUrl);
    await seedCache(specSource.cachePath, api.apiUrl, clock.time - 2 * 60 * 1000);
    const loaded = await specSource.get();
    expect(loaded.origin).toBe("cache");
    expect(api.requests).toHaveLength(0);
  });

  test("an old cache sends If-None-Match and keeps itself on 304", async () => {
    const { specSource, clock } = source(api.apiUrl);
    await seedCache(specSource.cachePath, api.apiUrl, clock.time - 30 * 60 * 1000);
    const loaded = await specSource.get();
    expect(api.requests[0]?.headers["if-none-match"]).toBe('"v1"');
    expect(loaded.origin).toBe("network");
    expect(loaded.document).toEqual(spec);
    const cached = JSON.parse(await readFile(specSource.cachePath, "utf8"));
    expect(cached.checkedAt).toBe(clock.time);
    expect(clock.time - cached.checkedAt).toBeLessThan(SPEC_FRESH_MS);
  });

  test("a cache of another API URL is not used", async () => {
    const { specSource, clock } = source(api.apiUrl);
    await seedCache(specSource.cachePath, "https://other.example/v1", clock.time);
    expect((await specSource.get()).origin).toBe("network");
  });

  test("a network failure with a cache warns once and uses the cache", async () => {
    const url = await closedApiUrl();
    const { specSource, warnings, clock } = source(url);
    await seedCache(specSource.cachePath, url, clock.time - 30 * 60 * 1000);
    const loaded = await specSource.get();
    expect(loaded.origin).toBe("stale");
    expect(loaded.document).toEqual(spec);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not be checked");
  });

  test("no cache and no network fails with CLI_SPEC_UNAVAILABLE", async () => {
    const { specSource } = source(await closedApiUrl());
    const failure = await specSource.get().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe("CLI_SPEC_UNAVAILABLE");
  });

  test("an answer that is not a spec fails with CLI_SPEC_UNAVAILABLE", async () => {
    api.handler = () =>
      new Response("<html>bad gateway</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    const { specSource } = source(api.apiUrl);
    const failure = (await specSource.get().catch((error: unknown) => error)) as CliError;
    expect(failure.code).toBe("CLI_SPEC_UNAVAILABLE");
    expect(failure.details).toMatchObject({ cause: { status: 200, contentType: "text/html" } });
  });

  test("an unknown command refreshes once, and only once", async () => {
    const { specSource, clock } = source(api.apiUrl);
    await seedCache(specSource.cachePath, api.apiUrl, clock.time - 60 * 1000, '"old"');
    expect((await specSource.get()).origin).toBe("cache");
    expect(api.requests).toHaveLength(0);
    const refreshed = await specSource.refresh();
    expect(refreshed?.origin).toBe("network");
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.headers["if-none-match"]).toBe('"old"');
    expect(await specSource.refresh()).toBeUndefined();
    expect(api.requests).toHaveLength(1);
  });

  test("two processes writing at once leave a valid file", async () => {
    const path = join(cacheDirectory, "spec", "race.json");
    const writer = join(import.meta.dir, "..", "helpers", "writeCacheLoop.ts");
    const content = JSON.stringify({ spec, padding: "x".repeat(200_000) });
    const contentPath = join(cacheDirectory, "content.json");
    await writeFile(contentPath, content);
    const children = [1, 2].map(() =>
      Bun.spawn(["bun", writer, path, contentPath, "150"], { stdout: "ignore", stderr: "inherit" }),
    );
    let reads = 0;
    const done = Promise.all(children.map((child) => child.exited));
    let finished = false;
    void done.then(() => {
      finished = true;
    });
    while (!finished) {
      const text = await readFile(path, "utf8").catch(() => undefined);
      if (text !== undefined) {
        expect(text).toBe(content);
        reads += 1;
      }
      await Bun.sleep(1);
    }
    expect(await done).toEqual([0, 0]);
    expect(reads).toBeGreaterThan(0);
    expect(await readFile(path, "utf8")).toBe(content);
  });
});
