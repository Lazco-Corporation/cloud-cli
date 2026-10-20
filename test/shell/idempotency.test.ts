import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cliEnv, FAKE_TOKEN, makeHome, runInProcess, seedSpecCache } from "../helpers/cli";
import { DroppingApi } from "../helpers/droppingApi";
import { closedApiUrl, FakeApi, fakeClock, json, type RecordedRequest } from "../helpers/fakeApi";
import { loadFixture } from "../helpers/fixtures";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A spend run with a quote it already has, so the key is the only thing these tests look at. */
const CREATE = [
  "compute",
  "create",
  "--hostname",
  "web-1",
  "--region-slug",
  "txg1",
  "--plan-slug",
  "s1",
  "--quote-id",
  "q-1",
  "--expected-amount",
  "402.500",
  "--yes",
  "--no-wait",
];

/** The error of the one error line, which follows the quote's notice on stderr. */
function errorOf(stderr: string) {
  return JSON.parse(stderr.trim().split("\n").at(-1) as string).error;
}

/**
 * An API that keeps the first answer of each key, as the backend layer does:
 * a key seen before answers its stored result with `Idempotent-Replayed: true`.
 */
function keyStoreApi() {
  const servers: string[] = [];
  const stored = new Map<string, unknown>();
  const api = new FakeApi((request: RecordedRequest) => {
    if (request.method === "POST" && request.path === "/v1/servers") {
      const key = request.headers["idempotency-key"];
      if (key === undefined) {
        return json(400, { error: "Key required", code: "IDEMPOTENCY_KEY_REQUIRED" });
      }
      const previous = stored.get(key);
      if (previous !== undefined) {
        return json(202, previous, { "idempotent-replayed": "true" });
      }
      const serverId = `srv-${servers.length + 1}`;
      servers.push(serverId);
      const body = { taskId: `t-${servers.length}`, serverId, password: "once-only" };
      stored.set(key, body);
      return json(202, body);
    }
    if (request.method === "POST" && request.path === "/v1/ssh-keys") {
      return json(201, { id: "k-1" });
    }
    if (request.method === "GET" && request.path === "/v1/servers") {
      return json(200, { data: [], nextCursor: null });
    }
    return json(404, { error: "Not found", code: "NOT_FOUND" });
  });
  return { api, servers };
}

let store: ReturnType<typeof keyStoreApi>;
let home: Awaited<ReturnType<typeof makeHome>>;

beforeEach(async () => {
  store = keyStoreApi();
  home = await makeHome();
  await seedSpecCache(home.cache, store.api.apiUrl, loadFixture("surface"));
});

afterEach(async () => {
  store.api.stop();
  await home.cleanup();
});

const env = () => cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN });
const run = (args: readonly string[]) =>
  runInProcess(["--api-url", store.api.apiUrl, ...args], { env: env() });
const createRequests = () =>
  store.api.requests.filter(
    (request) => request.method === "POST" && request.path === "/v1/servers",
  );

describe("the core sends an Idempotency-Key where the spec declares one", () => {
  test("a spend command run with --yes sends a UUID v4 key", async () => {
    const result = await run(CREATE);
    expect(result.code).toBe(0);
    expect(createRequests()).toHaveLength(1);
    expect(createRequests()[0]?.headers["idempotency-key"]).toMatch(UUID_V4);
  });

  test("two runs of one command send two keys, and the API handles two requests", async () => {
    const first = await run(CREATE);
    const second = await run(CREATE);
    const keys = createRequests().map((request) => request.headers["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(store.servers).toEqual(["srv-1", "srv-2"]);
    expect(JSON.parse(first.stdout).serverId).toBe("srv-1");
    expect(JSON.parse(second.stdout).serverId).toBe("srv-2");
    expect(second.stderr).not.toContain("Idempotency-Key");
  });

  test("a read command sends no key", async () => {
    const result = await run(["compute", "list"]);
    expect(result.code).toBe(0);
    const list = store.api.requests.find((request) => request.path === "/v1/servers");
    expect(list).toBeDefined();
    expect(list?.method).toBe("GET");
    expect(list?.headers["idempotency-key"]).toBeUndefined();
  });

  test("a write whose header is optional sends a key too", async () => {
    const result = await run([
      "ssh-keys",
      "create",
      "--name",
      "laptop",
      "--public-key",
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5",
    ]);
    expect(result.code).toBe(0);
    const request = store.api.requests.find((candidate) => candidate.path === "/v1/ssh-keys");
    expect(request?.headers["idempotency-key"]).toMatch(UUID_V4);
  });

  test("--describe keeps the header out of the input schema", async () => {
    const result = await run(["compute", "create", "--describe"]);
    expect(result.code).toBe(0);
    const described = JSON.parse(result.stdout);
    expect(JSON.stringify(described.inputSchema).toLowerCase()).not.toContain("idempotency");
    expect(Object.keys(described.flags)).not.toContain("--idempotency-key");
    expect(described.idempotencyKey).toBe("required");
  });

  test("a connection that drops after the API charged is sent again with the same key", async () => {
    // The fake charges once per new key, as the API's key layer does.
    const charged = new Set<string>();
    const dropping = await DroppingApi.start((request, index) => {
      const body = { taskId: "t-1", serverId: "srv-1", password: "once-only" };
      const key = request.headers["idempotency-key"] ?? `none-${index}`;
      const replay = charged.has(key);
      charged.add(key);
      if (index === 0) {
        return "drop";
      }
      if (!replay) {
        return { status: 202, body: { ...body, serverId: "srv-2" } };
      }
      return {
        status: 202,
        body: { ...body, key: request.headers["idempotency-key"] },
        headers: { "idempotent-replayed": "true" },
      };
    });
    try {
      await seedSpecCache(home.cache, dropping.apiUrl, loadFixture("surface"));
      const result = await runInProcess(["--api-url", dropping.apiUrl, ...CREATE], {
        env: env(),
        clock: fakeClock(),
      });
      expect(result.code).toBe(0);
      const keys = dropping.requests.map((request) => request.headers["idempotency-key"]);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(UUID_V4);
      expect(keys[1]).toBe(keys[0] as string);
      expect(charged.size).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        taskId: "t-1",
        serverId: "srv-1",
        password: "once-only",
        key: keys[0],
      });
      expect(result.stderr).toContain(`Idempotency-Key ${keys[0]}`);
    } finally {
      await dropping.stop();
    }
  });
});

describe("a keyed request that the API refuses", () => {
  test("402 INSUFFICIENT_CREDIT is not sent again: stderr has the error and the exit is 1", async () => {
    store.api.handler = () =>
      json(402, { error: "Not enough credit", code: "INSUFFICIENT_CREDIT" });
    const result = await run(CREATE);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(errorOf(result.stderr)).toMatchObject({
      status: 402,
      code: "INSUFFICIENT_CREDIT",
    });
    expect(createRequests()).toHaveLength(1);
  });

  test("IDEMPOTENCY_KEY_INTERRUPTED passes through with its code and message", async () => {
    store.api.handler = () =>
      json(409, {
        error: "Conflict",
        message: "The first request with this Idempotency-Key stopped before its answer was stored",
        code: "IDEMPOTENCY_KEY_INTERRUPTED",
      });
    const result = await run([...CREATE, "--idempotency-key", "deploy-42"]);
    expect(result.code).toBe(1);
    expect(errorOf(result.stderr)).toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_KEY_INTERRUPTED",
      message: "The first request with this Idempotency-Key stopped before its answer was stored",
    });
    expect(createRequests()).toHaveLength(1);
  });

  test("no answer after every try prints the generated key to run again with", async () => {
    store.api.handler = () => new Response("<html>502</html>", { status: 502 });
    const result = await runInProcess(["--api-url", store.api.apiUrl, ...CREATE], {
      env: env(),
      clock: fakeClock(),
    });
    expect(result.code).toBe(1);
    expect(createRequests()).toHaveLength(5);
    const key = createRequests()[0]?.headers["idempotency-key"] as string;
    expect(key).toMatch(UUID_V4);
    expect(result.stderr).toContain(
      `the request may have run. To get its result instead of running it again, run the same command with --idempotency-key ${key}`,
    );
    expect(JSON.parse(result.stderr.trim().split("\n").at(-1) as string).error.code).toBe(
      "CLI_BAD_RESPONSE",
    );
  });

  for (const [label, answer] of [
    [
      "IDEMPOTENCY_KEY_IN_PROGRESS",
      () =>
        json(
          409,
          { error: "Still running", code: "IDEMPOTENCY_KEY_IN_PROGRESS" },
          { "retry-after": "1" },
        ),
    ],
    [
      "a 429 with a long Retry-After",
      () => json(429, { error: "Too many", code: "RATE_LIMITED" }, { "retry-after": "600" }),
    ],
  ] as const) {
    test(`${label} at the end prints the generated key too`, async () => {
      store.api.handler = answer;
      const result = await runInProcess(["--api-url", store.api.apiUrl, ...CREATE], {
        env: env(),
        clock: fakeClock(),
      });
      expect(result.code).toBe(1);
      const key = createRequests()[0]?.headers["idempotency-key"] as string;
      expect(result.stderr).toContain(`run the same command with --idempotency-key ${key}`);
    });
  }

  test("no connection at all prints the generated key too", async () => {
    const closed = await closedApiUrl();
    await seedSpecCache(home.cache, closed, loadFixture("surface"));
    const result = await runInProcess(["--api-url", closed, ...CREATE], {
      env: env(),
      clock: fakeClock(),
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr.trim().split("\n").at(-1) as string).error.code).toBe(
      "CLI_NETWORK",
    );
    expect(result.stderr).toMatch(/run the same command with --idempotency-key [0-9a-f-]{36}/);
  });

  test("the key is not printed again when the user gave it, or after a final answer", async () => {
    store.api.handler = () => new Response("<html>502</html>", { status: 502 });
    const given = await runInProcess(
      ["--api-url", store.api.apiUrl, ...CREATE, "--idempotency-key", "deploy-42"],
      { env: env(), clock: fakeClock() },
    );
    expect(given.stderr).not.toContain("may have run");
    store.api.handler = () =>
      json(402, { error: "Not enough credit", code: "INSUFFICIENT_CREDIT" });
    const final = await run(CREATE);
    expect(final.stderr).not.toContain("may have run");
  });

  test("a replayed refusal also carries the replay note", async () => {
    store.api.handler = () =>
      json(
        402,
        { error: "Not enough credit", code: "INSUFFICIENT_CREDIT" },
        {
          "idempotent-replayed": "true",
        },
      );
    const result = await run([...CREATE, "--idempotency-key", "deploy-42"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Idempotency-Key deploy-42. Nothing ran again");
    expect(result.stderr).toContain("INSUFFICIENT_CREDIT");
  });
});

describe("--idempotency-key", () => {
  test("a script that runs again with the same key gets the same JSON, and one server", async () => {
    const args = [...CREATE, "--idempotency-key", "deploy-42"];
    const first = await run(args);
    const second = await run(args);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(createRequests().map((request) => request.headers["idempotency-key"])).toEqual([
      "deploy-42",
      "deploy-42",
    ]);
    expect(store.servers).toEqual(["srv-1"]);
    expect(second.stdout).toBe(first.stdout);
    expect(first.stderr).not.toContain("Nothing ran again");
    expect(second.stderr).toContain(
      "note: this is the stored result of the first request with Idempotency-Key deploy-42. Nothing ran again",
    );
  });

  test("the inline form works", async () => {
    await run([...CREATE, "--idempotency-key=deploy-43"]);
    expect(createRequests()[0]?.headers["idempotency-key"]).toBe("deploy-43");
  });

  for (const [label, value] of [
    ["a space", "a b"],
    ["an empty value", ""],
    ["256 characters", "k".repeat(256)],
    ["a non-ASCII character", "clé"],
  ] as const) {
    test(`${label} is CLI_INVALID_INPUT and sends no request`, async () => {
      const result = await run([...CREATE, `--idempotency-key=${value}`]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const error = errorOf(result.stderr);
      expect(error.code).toBe("CLI_INVALID_INPUT");
      expect(error.details[0].field).toBe("idempotency-key");
      expect(store.api.requests).toEqual([]);
    });
  }

  test("255 printable characters pass", async () => {
    const key = "~".repeat(255);
    const result = await run([...CREATE, "--idempotency-key", key]);
    expect(result.code).toBe(0);
    expect(createRequests()[0]?.headers["idempotency-key"]).toBe(key);
  });

  test("given twice is CLI_INVALID_INPUT", async () => {
    const result = await run([...CREATE, "--idempotency-key", "a", "--idempotency-key", "b"]);
    expect(result.code).toBe(1);
    expect(errorOf(result.stderr).code).toBe("CLI_INVALID_INPUT");
    expect(store.api.requests).toEqual([]);
  });

  test("a command whose header is not required has no such flag", async () => {
    for (const args of [
      ["compute", "list", "--idempotency-key", "k"],
      ["ssh-keys", "create", "--name", "a", "--public-key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"],
    ]) {
      const result = await run(args[0] === "ssh-keys" ? [...args, "--idempotency-key", "k"] : args);
      expect(result.code).toBe(1);
      expect(errorOf(result.stderr).details[0]).toEqual({
        field: "idempotency-key",
        message: "--idempotency-key is not a flag of this command",
      });
    }
    expect(store.api.requests).toEqual([]);
  });

  test("--help of a spend command lists --yes and --idempotency-key", async () => {
    const result = await run(["compute", "create", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--yes");
    expect(result.stdout).toContain("--idempotency-key");
    const read = await run(["compute", "list", "--help"]);
    expect(read.stdout).not.toContain("--idempotency-key");
    expect(read.stdout).not.toContain("--yes");
  });

  test("--help of a destructive command lists --yes only", async () => {
    const result = await run(["compute", "delete", "--help"]);
    expect(result.stdout).toContain("--yes");
    expect(result.stdout).not.toContain("--idempotency-key");
  });
});

describe("--dry-run of a spend command", () => {
  test("prints the Idempotency-Key header with the key it would send, and sends nothing", async () => {
    const result = await run([...CREATE, "--dry-run"]);
    expect(result.code).toBe(0);
    const preview = JSON.parse(result.stdout);
    expect(preview.headers["Idempotency-Key"]).toMatch(UUID_V4);
    expect(store.api.requests).toEqual([]);
  });

  test("prints the key of --idempotency-key", async () => {
    const result = await run([...CREATE, "--dry-run", "--idempotency-key", "deploy-42"]);
    expect(JSON.parse(result.stdout).headers["Idempotency-Key"]).toBe("deploy-42");
    expect(store.api.requests).toEqual([]);
  });
});
