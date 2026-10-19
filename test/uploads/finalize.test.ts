import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CliError } from "../../src/core/errors";
import { ApiClient } from "../../src/core/request/client";
import { RateLimiter } from "../../src/core/request/rateLimiter";
import { staticCredential } from "../../src/credentials/credential";
import { Interrupted } from "../../src/uploads/interrupted";
import {
  type Deployment,
  finalizeDeployment,
  POLL_INTERVAL_MS,
  waitForDeployment,
} from "../../src/uploads/pages/finalize";
import { FAKE_TOKEN } from "../helpers/cli";
import { FakeApi, fakeClock, json } from "../helpers/fakeApi";

const PATH = "/labs/pages/sites/site-1/deployments/dep-1";
let api: FakeApi;
let statuses: string[];
let finalizeDrops: number;

beforeEach(() => {
  statuses = ["finalizing", "live"];
  finalizeDrops = 0;
  let reads = 0;
  api = new FakeApi((request) => {
    if (request.method === "GET" && request.path === `/v1${PATH}`) {
      const status = statuses[Math.min(reads, statuses.length - 1)] as string;
      reads += 1;
      return json(200, {
        id: "dep-1",
        status,
        error: status === "failed" ? "PAGES_UPLOAD_INCOMPLETE" : null,
      });
    }
    if (request.method === "POST" && request.path === `/v1${PATH}/finalize`) {
      return json(202, { id: "dep-1", status: "finalizing", error: null });
    }
    return json(404, { error: "Not found", code: "NOT_FOUND" });
  });
});

afterEach(() => {
  api.stop();
});

/** A client whose first `finalizeDrops` finalize requests get no answer. */
function client(clock = fakeClock()): ApiClient {
  return new ApiClient({
    apiUrl: api.apiUrl,
    credential: staticCredential(FAKE_TOKEN),
    userAgent: "lazco-test",
    limiter: new RateLimiter(clock),
    clock,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/finalize") && finalizeDrops > 0) {
        finalizeDrops -= 1;
        throw new TypeError("socket hang up");
      }
      return fetch(input, init);
    }) as typeof fetch,
  });
}

const finalizing: Deployment = { id: "dep-1", status: "finalizing" };

function wait(
  options: { clock?: ReturnType<typeof fakeClock>; timeout?: number; signal?: AbortSignal } = {},
) {
  const clock = options.clock ?? fakeClock();
  return waitForDeployment({
    client: client(clock),
    deploymentPath: PATH,
    deployment: finalizing,
    clock,
    timeoutSeconds: options.timeout ?? 600,
    signal: options.signal ?? new AbortController().signal,
  });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

function calls(): string[] {
  return api.requests.map((request) => `${request.method} ${request.path.replace("/v1", "")}`);
}

describe("the wait", () => {
  test("live ends the wait, read every 5 seconds", async () => {
    const clock = fakeClock();
    expect((await wait({ clock })).status).toBe("live");
    expect(clock.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
    expect(POLL_INTERVAL_MS).toBe(5000);
  });

  test("superseded is a success too", async () => {
    statuses = ["superseded"];
    expect((await wait()).status).toBe("superseded");
  });

  test("failed is CLI_TASK_FAILED with the deployment's error", async () => {
    statuses = ["finalizing", "failed"];
    const error = (await failure(wait())) as CliError;
    expect(error.code).toBe("CLI_TASK_FAILED");
    expect(error.details).toEqual({
      deployment: { id: "dep-1", status: "failed", error: "PAGES_UPLOAD_INCOMPLETE" },
      error: "PAGES_UPLOAD_INCOMPLETE",
    });
  });

  test("abandoned and cancelled are CLI_TASK_FAILED", async () => {
    for (const status of ["abandoned", "cancelled"]) {
      statuses = [status];
      const error = (await failure(wait())) as CliError;
      expect(error.code).toBe("CLI_TASK_FAILED");
      expect(error.message).toContain(status);
    }
  });

  test("--timeout ends the wait with CLI_TIMEOUT and sends no cancel", async () => {
    statuses = ["finalizing"];
    const clock = fakeClock();
    const error = (await failure(wait({ clock, timeout: 12 }))) as CliError;
    expect(error.code).toBe("CLI_TIMEOUT");
    expect(error.details).toEqual({
      deployment: { id: "dep-1", status: "finalizing", error: null },
    });
    expect(clock.sleeps).toEqual([5000, 5000, 2000]);
    expect(calls().every((call) => call.startsWith("GET "))).toBe(true);
  });

  test("an interrupt stops the wait and sends nothing", async () => {
    statuses = ["finalizing"];
    const controller = new AbortController();
    controller.abort();
    expect(await failure(wait({ signal: controller.signal }))).toBeInstanceOf(Interrupted);
    expect(calls()).toEqual([]);
  });
});

describe("finalize", () => {
  test("answers the finalizing deployment", async () => {
    expect((await finalizeDeployment(client(), PATH)).status).toBe("finalizing");
    expect(calls()).toEqual([`POST ${PATH}/finalize`]);
  });

  test("after no answer, a read that is still uploading gets a second finalize", async () => {
    finalizeDrops = 1;
    statuses = ["uploading"];
    expect((await finalizeDeployment(client(), PATH)).status).toBe("finalizing");
    expect(calls()).toEqual([`GET ${PATH}`, `POST ${PATH}/finalize`]);
  });

  test("after no answer, a read past uploading gets no second finalize", async () => {
    finalizeDrops = 1;
    statuses = ["finalizing"];
    expect((await finalizeDeployment(client(), PATH)).status).toBe("finalizing");
    expect(calls()).toEqual([`GET ${PATH}`]);
  });

  test("an API error of finalize passes through", async () => {
    api.handler = () => json(409, { error: "Expired", code: "PAGES_UPLOAD_EXPIRED" });
    const error = await failure(finalizeDeployment(client(), PATH));
    expect(error).toEqual(expect.objectContaining({ code: "PAGES_UPLOAD_EXPIRED", status: 409 }));
  });
});
