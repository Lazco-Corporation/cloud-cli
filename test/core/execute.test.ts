import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ApiError, CliError } from "../../src/core/errors";
import { generateSurface, type Operation } from "../../src/core/generate/operations";
import { createAjv } from "../../src/core/request/ajv";
import { prepareRequest } from "../../src/core/request/build";
import { ApiClient } from "../../src/core/request/client";
import { executeOperation } from "../../src/core/request/execute";
import { RateLimiter } from "../../src/core/request/rateLimiter";
import { InputValidator } from "../../src/core/request/validate";
import { FakeApi, fakeClock, json, type RecordedRequest } from "../helpers/fakeApi";
import { loadFixture } from "../helpers/fixtures";

const ajv = createAjv();
const validator = new InputValidator(ajv);
const operations = generateSurface(loadFixture("surface"), ajv).operations;

function operation(command: string): Operation {
  const found = operations.find((candidate) => candidate.command.join(" ") === command);
  if (!found) throw new Error(command);
  return found;
}

let api: FakeApi;
beforeEach(() => {
  api = new FakeApi();
});
afterEach(() => {
  api.stop();
});

function setup() {
  const clock = fakeClock();
  const client = new ApiClient({
    apiUrl: api.apiUrl,
    credential: "lz_live_000000000000000000000000000000000000000000000000aaaaaaaaaaaaaaaa",
    userAgent: "lazco-cli/test",
    limiter: new RateLimiter(clock),
    clock,
    random: () => 0.5,
  });
  const run = (
    command: string,
    input: Record<string, unknown>,
    options = { wait: true, timeoutSeconds: 600 },
  ) =>
    executeOperation(
      operation(command),
      prepareRequest(operation(command), input, { apiUrl: api.apiUrl, validator }),
      { client, clock },
      options,
    );
  return { clock, run };
}

/** Answers the 202, then the task reads in order. */
function taskServer(accepted: unknown, statuses: string[]) {
  let reads = 0;
  return (request: RecordedRequest) => {
    if (request.path.startsWith("/v1/tasks/")) {
      const status = statuses[Math.min(reads, statuses.length - 1)] as string;
      reads += 1;
      return json(200, {
        id: "t-1",
        status,
        progress: reads * 10,
        ...(status === "failed" ? { error: "No capacity", errorCode: "NO_CAPACITY" } : {}),
      });
    }
    return json(202, accepted);
  };
}

describe("task wait", () => {
  test("completed prints accepted and task, with the 202 password kept", async () => {
    api.handler = taskServer({ taskId: "t-1", password: "only-sent-once" }, [
      "pending",
      "running",
      "running",
      "completed",
    ]);
    const { run, clock } = setup();
    const result = await run("compute create", {
      hostname: "web-1",
      regionSlug: "txg1",
      planSlug: "s1",
    });
    expect(result).toEqual({
      accepted: { taskId: "t-1", password: "only-sent-once" },
      task: { id: "t-1", status: "completed", progress: 40 },
    });
    expect(api.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /v1/servers",
      "GET /v1/tasks/t-1",
      "GET /v1/tasks/t-1",
      "GET /v1/tasks/t-1",
      "GET /v1/tasks/t-1",
    ]);
    expect(clock.sleeps).toEqual([2000, 3000, 4500, 6750]);
  });

  test("the reads grow to 10 seconds apart and no further", async () => {
    api.handler = taskServer({ taskId: "t-1" }, [...Array(8).fill("running"), "completed"]);
    const { run, clock } = setup();
    await run("compute create", { hostname: "web-1", regionSlug: "txg1", planSlug: "s1" });
    expect(Math.max(...clock.sleeps)).toBe(10_000);
    expect(clock.sleeps.slice(-3)).toEqual([10_000, 10_000, 10_000]);
  });

  test("failed is CLI_TASK_FAILED with the 202 body and the task", async () => {
    api.handler = taskServer({ taskId: "t-1" }, ["running", "failed"]);
    const { run } = setup();
    const error = (await run("compute create", {
      hostname: "web-1",
      regionSlug: "txg1",
      planSlug: "s1",
    }).catch((failure: unknown) => failure)) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe("CLI_TASK_FAILED");
    expect(error.message).toBe("No capacity");
    expect(error.details).toMatchObject({
      accepted: { taskId: "t-1" },
      task: { status: "failed", errorCode: "NO_CAPACITY" },
    });
  });

  test("the timeout is CLI_TIMEOUT with the taskId and the 202 body", async () => {
    api.handler = taskServer({ taskId: "t-1", password: "only-sent-once" }, ["running"]);
    const { run, clock } = setup();
    const error = (await run(
      "compute create",
      { hostname: "web-1", regionSlug: "txg1", planSlug: "s1" },
      { wait: true, timeoutSeconds: 30 },
    ).catch((failure: unknown) => failure)) as CliError;
    expect(error.code).toBe("CLI_TIMEOUT");
    expect(error.details).toEqual({
      taskId: "t-1",
      accepted: { taskId: "t-1", password: "only-sent-once" },
    });
    expect(clock.sleeps.reduce((sum, value) => sum + value, 0)).toBe(30_000);
  });

  test("a failed task read keeps the 202 body in the error", async () => {
    api.handler = (request: RecordedRequest) =>
      request.path.startsWith("/v1/tasks/")
        ? json(404, { error: "Task not found", code: "NOT_FOUND" })
        : json(202, { taskId: "t-1", password: "only-sent-once" });
    const { run } = setup();
    const error = (await run("compute create", {
      hostname: "web-1",
      regionSlug: "txg1",
      planSlug: "s1",
    }).catch((failure: unknown) => failure)) as ApiError;
    expect(error.status).toBe(404);
    expect(error.toBody()).toMatchObject({
      status: 404,
      taskId: "t-1",
      accepted: { taskId: "t-1", password: "only-sent-once" },
    });
  });

  test("a task read that is not JSON keeps the 202 body in the error", async () => {
    api.handler = (request: RecordedRequest) =>
      request.path.startsWith("/v1/tasks/")
        ? new Response("<html>bad gateway</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })
        : json(202, { taskId: "t-1", password: "only-sent-once" });
    const { run } = setup();
    const error = (await run("compute create", {
      hostname: "web-1",
      regionSlug: "txg1",
      planSlug: "s1",
    }).catch((failure: unknown) => failure)) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe("CLI_BAD_RESPONSE");
    expect(error.details).toMatchObject({
      taskId: "t-1",
      accepted: { taskId: "t-1", password: "only-sent-once" },
    });
  });

  test("without the wait the 202 body comes back at once", async () => {
    api.handler = taskServer({ taskId: "t-1" }, ["running"]);
    const { run } = setup();
    const result = await run(
      "compute create",
      { hostname: "web-1", regionSlug: "txg1", planSlug: "s1" },
      { wait: false, timeoutSeconds: 600 },
    );
    expect(result).toEqual({ taskId: "t-1" });
    expect(api.requests).toHaveLength(1);
  });
});

describe("ETag flow", () => {
  test("ifMatch is sent as If-Match and skips the GET", async () => {
    api.handler = () => json(200, { version: 43 });
    const { run } = setup();
    await run("dns records set", { zoneId: "z-1", rrsets: [], ifMatch: '"42"' });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({ method: "PATCH", headers: { "if-match": '"42"' } });
  });

  test("no ifMatch sends the GET's ETag", async () => {
    api.handler = (request) =>
      request.method === "GET"
        ? json(200, { rrsets: [] }, { etag: '"43"' })
        : json(200, { version: 44 });
    const { run } = setup();
    const result = await run("dns records set", { zoneId: "z-1", rrsets: [] });
    expect(result).toEqual({ version: 44 });
    expect(
      api.requests.map((request) => [request.method, request.path, request.headers["if-match"]]),
    ).toEqual([
      ["GET", "/v1/dns/zones/z-1/rrsets", undefined],
      ["PATCH", "/v1/dns/zones/z-1/rrsets", '"43"'],
    ]);
  });

  test("a GET without an ETag is CLI_BAD_RESPONSE and nothing is written", async () => {
    api.handler = () => json(200, { rrsets: [] });
    const { run } = setup();
    const error = (await run("dns records set", { zoneId: "z-1", rrsets: [] }).catch(
      (failure: unknown) => failure,
    )) as CliError;
    expect(error.code).toBe("CLI_BAD_RESPONSE");
    expect(api.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  test("a 412 is returned as it came and not retried", async () => {
    api.handler = () =>
      json(412, {
        error: "Precondition failed",
        code: "DNS_VERSION_MISMATCH",
        version: 43,
        timestamp: "t",
      });
    const { run } = setup();
    const error = (await run("dns records set", {
      zoneId: "z-1",
      rrsets: [],
      ifMatch: '"42"',
    }).catch((failure: unknown) => failure)) as ApiError;
    expect(error.toBody()).toEqual({
      status: 412,
      code: "DNS_VERSION_MISMATCH",
      message: "Precondition failed",
      version: 43,
      timestamp: "t",
    });
    expect(api.requests).toHaveLength(1);
  });
});
