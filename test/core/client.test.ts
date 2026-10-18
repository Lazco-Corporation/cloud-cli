import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiError, CliError } from "../../src/core/errors";
import { ApiClient, parseRetryAfter } from "../../src/core/request/client";
import { SYSTEM_CLOCK } from "../../src/core/request/clock";
import { RateLimiter } from "../../src/core/request/rateLimiter";
import { closedApiUrl, FakeApi, fakeClock, json } from "../helpers/fakeApi";

const TOKEN = "lz_live_000000000000000000000000000000000000000000000000c0ffee00c0ffee00";

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
});

afterEach(() => {
  api.stop();
});

function client(options: { apiUrl?: string; timeoutMs?: number } = {}) {
  const clock = fakeClock();
  return {
    clock,
    client: new ApiClient({
      apiUrl: options.apiUrl ?? api.apiUrl,
      credential: TOKEN,
      userAgent: "lazco-cli/9.9.9",
      limiter: new RateLimiter(clock),
      clock,
      random: () => 0.5,
      timeoutMs: options.timeoutMs,
    }),
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (error: unknown) => error,
  );
}

/** Answers each request with the next response of a list, then 200. */
function sequence(...responses: Array<() => Response>) {
  let index = 0;
  return () => {
    const next = responses[index];
    index += 1;
    return next ? next() : json(200, { ok: true });
  };
}

describe("API client", () => {
  test("sends the User-Agent, the credential and a JSON body", async () => {
    api.handler = () => json(201, { id: "k-1" });
    const { client: apiClient } = client();
    const response = await apiClient.call({
      method: "post",
      path: "/ssh-keys",
      body: { name: "a" },
    });
    expect(response.body).toEqual({ id: "k-1" });
    expect(api.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/ssh-keys",
      body: { name: "a" },
      headers: {
        "user-agent": "lazco-cli/9.9.9",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
    });
  });

  test("a GET is retried after a 503", async () => {
    api.handler = sequence(() => json(503, { error: "Busy", code: "SERVICE_UNAVAILABLE" }));
    const { client: apiClient, clock } = client();
    const response = await apiClient.call({ method: "GET", path: "/servers" });
    expect(response.body).toEqual({ ok: true });
    expect(api.requests).toHaveLength(2);
    expect(clock.sleeps).toEqual([500]);
  });

  test("a GET is tried three times in all, with growing waits", async () => {
    api.handler = () => json(502, { error: "Bad gateway", code: "BAD_GATEWAY" });
    const { client: apiClient, clock } = client();
    const error = await failure(apiClient.call({ method: "GET", path: "/servers" }));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect(api.requests).toHaveLength(3);
    expect(clock.sleeps).toEqual([500, 1000]);
  });

  test("a POST is not retried", async () => {
    api.handler = () => json(503, { error: "Busy", code: "SERVICE_UNAVAILABLE" });
    const { client: apiClient } = client();
    const error = (await failure(
      apiClient.call({ method: "POST", path: "/servers", body: {} }),
    )) as ApiError;
    expect(error.status).toBe(503);
    expect(api.requests).toHaveLength(1);
  });

  test("a POST with Idempotency-Key is retried", async () => {
    api.handler = sequence(() => json(504, { error: "Timeout", code: "GATEWAY_TIMEOUT" }));
    const { client: apiClient } = client();
    await apiClient.call({
      method: "POST",
      path: "/x",
      body: {},
      headers: { "Idempotency-Key": "k" },
    });
    expect(api.requests).toHaveLength(2);
  });

  test("Retry-After is honored up to 60 seconds", async () => {
    api.handler = sequence(() =>
      json(429, { error: "Too many", code: "RATE_LIMITED" }, { "retry-after": "3" }),
    );
    const { client: apiClient, clock } = client();
    await apiClient.call({ method: "GET", path: "/servers" });
    expect(clock.sleeps).toEqual([3000]);
    expect(api.requests).toHaveLength(2);
  });

  test("a Retry-After over 60 seconds returns the 429 at once", async () => {
    api.handler = () =>
      json(429, { error: "Too many", code: "RATE_LIMITED" }, { "retry-after": "61" });
    const { client: apiClient, clock } = client();
    const error = (await failure(apiClient.call({ method: "GET", path: "/servers" }))) as ApiError;
    expect(error.status).toBe(429);
    expect(error.code).toBe("RATE_LIMITED");
    expect(api.requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  test("Retry-After as a date", () => {
    const now = Date.parse("2026-10-18T00:00:00Z");
    expect(parseRetryAfter("Sun, 18 Oct 2026 00:00:05 GMT", now)).toBe(5);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
  });

  test("an HTML 502 is CLI_BAD_RESPONSE with the status and content type", async () => {
    api.handler = () =>
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    const { client: apiClient } = client();
    const error = (await failure(apiClient.call({ method: "POST", path: "/servers" }))) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error.toBody()).toEqual({
      code: "CLI_BAD_RESPONSE",
      message: "The API answered with an unexpected body",
      details: { status: 502, contentType: "text/html" },
    });
  });

  test("a DNS body with error and message keeps the specific message", async () => {
    api.handler = () =>
      json(412, {
        error: "Precondition failed",
        message: "The zone changed since version 42",
        code: "DNS_VERSION_MISMATCH",
        version: 43,
        issues: [],
        timestamp: "2026-10-18T00:00:00Z",
      });
    const { client: apiClient } = client();
    const error = (await failure(
      apiClient.call({ method: "PATCH", path: "/dns/zones/z/rrsets" }),
    )) as ApiError;
    expect(error.toBody()).toEqual({
      status: 412,
      code: "DNS_VERSION_MISMATCH",
      message: "The zone changed since version 42",
      version: 43,
      issues: [],
      timestamp: "2026-10-18T00:00:00Z",
    });
  });

  test("a body with error only moves it to message and keeps the rest", async () => {
    api.handler = () =>
      json(400, {
        error: "Bad input",
        code: "VALIDATION_ERROR",
        details: "name: required",
        timestamp: "t",
      });
    const { client: apiClient } = client();
    const error = (await failure(apiClient.call({ method: "POST", path: "/x" }))) as ApiError;
    expect(JSON.stringify({ error: error.toBody() })).toBe(
      '{"error":{"status":400,"code":"VALIDATION_ERROR","message":"Bad input","details":"name: required","timestamp":"t"}}',
    );
  });

  test("the credential is removed from every error", async () => {
    api.handler = () =>
      json(401, {
        error: `Token ${TOKEN} is not valid`,
        code: "UNAUTHORIZED",
        echo: { [TOKEN]: TOKEN },
      });
    const { client: apiClient } = client();
    const error = (await failure(apiClient.call({ method: "GET", path: "/whoami" }))) as ApiError;
    expect(JSON.stringify(error.toBody())).not.toContain(TOKEN.slice(8));
    expect(error.message).toBe("Token [REDACTED] is not valid");
  });

  test("a refused connection is CLI_NETWORK after every try", async () => {
    const { client: apiClient } = client({ apiUrl: await closedApiUrl() });
    const error = (await failure(apiClient.call({ method: "GET", path: "/servers" }))) as CliError;
    expect(error.code).toBe("CLI_NETWORK");
  });

  test("no answer in time is CLI_TIMEOUT", async () => {
    api.handler = async () => {
      await Bun.sleep(300);
      return json(200, {});
    };
    const { client: apiClient } = client({ timeoutMs: 50 });
    const error = (await failure(apiClient.call({ method: "POST", path: "/slow" }))) as CliError;
    expect(error.code).toBe("CLI_TIMEOUT");
  });

  test("40 requests take at least 3.9 seconds", async () => {
    api.handler = () => json(200, {});
    const apiClient = new ApiClient({
      apiUrl: api.apiUrl,
      userAgent: "lazco-cli/test",
      limiter: new RateLimiter(SYSTEM_CLOCK),
    });
    const started = performance.now();
    await Promise.all(
      Array.from({ length: 40 }, () => apiClient.call({ method: "GET", path: "/x" })),
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(3900);
    const times = api.requests.map((request) => request.at).sort((left, right) => left - right);
    for (let index = 10; index < times.length; index += 1) {
      expect((times[index] as number) - (times[index - 10] as number)).toBeGreaterThanOrEqual(990);
    }
  }, 10_000);
});
