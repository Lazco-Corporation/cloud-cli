import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiError, CliError } from "../../src/core/errors";
import { ApiClient, parseRetryAfter } from "../../src/core/request/client";
import { MONOTONIC_CLOCK } from "../../src/core/request/clock";
import { RateLimiter } from "../../src/core/request/rateLimiter";
import { staticCredential } from "../../src/credentials/credential";
import { DroppingApi } from "../helpers/droppingApi";
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
      credential: staticCredential(TOKEN),
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

  test("a GET is retried after a 503 that carries the API error shape", async () => {
    api.handler = sequence(() => json(503, { error: "Busy", code: "SERVICE_UNAVAILABLE" }));
    const { client: apiClient } = client();
    await apiClient.call({ method: "GET", path: "/servers" });
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

  test("a replayed answer is reported with its key, a first answer is not", async () => {
    api.handler = sequence(
      () => json(202, { id: "srv-1" }),
      () => json(202, { id: "srv-1" }, { "idempotent-replayed": "true" }),
      () =>
        json(
          402,
          { error: "No credit", code: "INSUFFICIENT_CREDIT" },
          {
            "idempotent-replayed": "true",
          },
        ),
    );
    const replays: string[] = [];
    const clock = fakeClock();
    const apiClient = new ApiClient({
      apiUrl: api.apiUrl,
      userAgent: "lazco-cli/test",
      limiter: new RateLimiter(clock),
      clock,
      onReplay: (key) => replays.push(key),
    });
    const keyed = { method: "POST", path: "/servers", headers: { "Idempotency-Key": "k-1" } };
    await apiClient.call(keyed);
    expect(replays).toEqual([]);
    await apiClient.call(keyed);
    expect(replays).toEqual(["k-1"]);
    await failure(apiClient.call(keyed));
    expect(replays).toEqual(["k-1", "k-1"]);
  });

  test("40 requests take at least 3.9 seconds", async () => {
    api.handler = () => json(200, {});
    const apiClient = new ApiClient({
      apiUrl: api.apiUrl,
      userAgent: "lazco-cli/test",
      limiter: new RateLimiter(MONOTONIC_CLOCK),
    });
    // The total is measured on the limiter's own clock. The spacing below uses the
    // fake API's arrival times, a second clock, so the two checks are independent.
    const started = MONOTONIC_CLOCK.now();
    await Promise.all(
      Array.from({ length: 40 }, () => apiClient.call({ method: "GET", path: "/x" })),
    );
    expect(MONOTONIC_CLOCK.now() - started).toBeGreaterThanOrEqual(3900);
    const times = api.requests.map((request) => request.at).sort((left, right) => left - right);
    for (let index = 10; index < times.length; index += 1) {
      expect((times[index] as number) - (times[index - 10] as number)).toBeGreaterThanOrEqual(990);
    }
  }, 10_000);
});

describe("a request with Idempotency-Key", () => {
  const keyed = (method = "POST") => ({
    method,
    path: "/servers",
    body: { hostname: "web-1" },
    headers: { "Idempotency-Key": "key-1" },
  });
  const keysSent = () => api.requests.map((request) => request.headers["idempotency-key"]);

  test("is tried five times in all, 1, 2, 4 and 8 seconds apart, with the same key", async () => {
    api.handler = () => new Response("<html>502</html>", { status: 502 });
    const { client: apiClient, clock } = client();
    const error = (await failure(apiClient.call(keyed()))) as CliError;
    expect(error.code).toBe("CLI_BAD_RESPONSE");
    expect(keysSent()).toEqual(["key-1", "key-1", "key-1", "key-1", "key-1"]);
    expect(clock.sleeps).toEqual([1000, 2000, 4000, 8000]);
  });

  test("a DELETE with a key is retried the same way", async () => {
    api.handler = sequence(() => new Response("", { status: 504 }));
    const { client: apiClient } = client();
    await apiClient.call(keyed("DELETE"));
    expect(keysSent()).toEqual(["key-1", "key-1"]);
  });

  test("is retried after a 503 that is not the API error shape", async () => {
    api.handler = sequence(
      () =>
        new Response("upstream down", { status: 503, headers: { "content-type": "text/plain" } }),
    );
    const { client: apiClient } = client();
    const response = await apiClient.call(keyed());
    expect(response.body).toEqual({ ok: true });
    expect(keysSent()).toEqual(["key-1", "key-1"]);
  });

  test("is not retried after a 502, 503 or 504 that the API itself answered", async () => {
    for (const status of [502, 503, 504]) {
      api.requests.length = 0;
      api.handler = () => json(status, { error: "Down", code: "PROVIDER_UNAVAILABLE" });
      const { client: apiClient } = client();
      const error = (await failure(apiClient.call(keyed()))) as ApiError;
      expect(error.status).toBe(status);
      expect(error.code).toBe("PROVIDER_UNAVAILABLE");
      expect(api.requests).toHaveLength(1);
    }
  });

  test("waits Retry-After on IDEMPOTENCY_KEY_IN_PROGRESS and sends the same key again", async () => {
    api.handler = sequence(
      () =>
        json(
          409,
          { error: "Still running", code: "IDEMPOTENCY_KEY_IN_PROGRESS" },
          { "retry-after": "1" },
        ),
      () => json(202, { taskId: "t-1" }, { "idempotent-replayed": "true" }),
    );
    const { client: apiClient, clock } = client();
    const response = await apiClient.call(keyed());
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ taskId: "t-1" });
    expect(clock.sleeps).toEqual([1000]);
    expect(keysSent()).toEqual(["key-1", "key-1"]);
  });

  test("IDEMPOTENCY_KEY_IN_PROGRESS on every try ends after five with that error", async () => {
    api.handler = () =>
      json(
        409,
        { error: "Still running", code: "IDEMPOTENCY_KEY_IN_PROGRESS" },
        { "retry-after": "1" },
      );
    const { client: apiClient, clock } = client();
    const error = (await failure(apiClient.call(keyed()))) as ApiError;
    expect(error.code).toBe("IDEMPOTENCY_KEY_IN_PROGRESS");
    expect(api.requests).toHaveLength(5);
    expect(clock.sleeps).toEqual([1000, 1000, 1000, 1000]);
  });

  test("is retried after a 429, and waits its Retry-After", async () => {
    api.handler = sequence(() =>
      json(429, { error: "Too many", code: "RATE_LIMITED" }, { "retry-after": "7" }),
    );
    const { client: apiClient, clock } = client();
    await apiClient.call(keyed());
    expect(clock.sleeps).toEqual([7000]);
    expect(keysSent()).toEqual(["key-1", "key-1"]);
  });

  test("a Retry-After over 60 seconds returns the answer at once", async () => {
    api.handler = () =>
      json(429, { error: "Too many", code: "RATE_LIMITED" }, { "retry-after": "120" });
    const { client: apiClient, clock } = client();
    const error = (await failure(apiClient.call(keyed()))) as ApiError;
    expect(error.status).toBe(429);
    expect(api.requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  test("an API error is final: 402 INSUFFICIENT_CREDIT is not retried", async () => {
    api.handler = () =>
      json(402, { error: "Not enough credit", code: "INSUFFICIENT_CREDIT", balance: "10.00" });
    const { client: apiClient } = client();
    const error = (await failure(apiClient.call(keyed()))) as ApiError;
    expect(error.toBody()).toEqual({
      status: 402,
      code: "INSUFFICIENT_CREDIT",
      message: "Not enough credit",
      balance: "10.00",
    });
    expect(api.requests).toHaveLength(1);
  });

  test("IDEMPOTENCY_KEY_INTERRUPTED and IDEMPOTENCY_KEY_REUSED pass through, not retried", async () => {
    for (const code of ["IDEMPOTENCY_KEY_INTERRUPTED", "IDEMPOTENCY_KEY_REUSED"]) {
      api.requests.length = 0;
      api.handler = () => json(409, { error: "Generic", message: `Specific ${code}`, code });
      const { client: apiClient } = client();
      const error = (await failure(apiClient.call(keyed()))) as ApiError;
      expect(error.code).toBe(code);
      expect(error.message).toBe(`Specific ${code}`);
      expect(api.requests).toHaveLength(1);
    }
  });

  test("a POST without a key is sent once, whatever the answer", async () => {
    api.handler = () => new Response("", { status: 502 });
    const { client: apiClient } = client();
    await failure(apiClient.call({ method: "POST", path: "/servers", body: {} }));
    expect(api.requests).toHaveLength(1);
  });

  test("a dropped connection is sent again with the same key, and the first result comes back", async () => {
    let charges = 0;
    const dropping = await DroppingApi.start((request, index) => {
      if (index === 0) {
        // The API created the server and charged, then the connection dropped.
        charges += 1;
        return "drop";
      }
      return {
        status: 202,
        body: { taskId: "t-1", key: request.headers["idempotency-key"] },
        headers: { "idempotent-replayed": "true" },
      };
    });
    try {
      const { client: apiClient, clock } = client({ apiUrl: dropping.apiUrl });
      const response = await apiClient.call(keyed());
      expect(response.body).toEqual({ taskId: "t-1", key: "key-1" });
      expect(dropping.requests.map((request) => request.headers["idempotency-key"])).toEqual([
        "key-1",
        "key-1",
      ]);
      expect(dropping.requests[1]?.body).toEqual(dropping.requests[0]?.body);
      expect(charges).toBe(1);
      expect(clock.sleeps).toEqual([1000]);
    } finally {
      await dropping.stop();
    }
  });

  test("a timeout is not sent again", async () => {
    api.handler = async () => {
      await Bun.sleep(300);
      return json(200, {});
    };
    const { client: apiClient } = client({ timeoutMs: 50 });
    const error = (await failure(apiClient.call(keyed()))) as CliError;
    expect(error.code).toBe("CLI_TIMEOUT");
    expect(api.requests).toHaveLength(1);
  });
});
