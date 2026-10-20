import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHome } from "../helpers/cli";
import type { FakeApi } from "../helpers/fakeApi";
import { type FixtureState, fixtureApi, operationRequests } from "../helpers/fixtureApi";
import { loadFixture } from "../helpers/fixtures";
import { type ConnectedSession, connectSession, resultJson } from "../helpers/mcp";

let api: FakeApi;
let state: FixtureState;
let home: Awaited<ReturnType<typeof makeHome>>;
let connected: ConnectedSession | undefined;

const READ_TOOLS = [
  "compute_get_server",
  "compute_list_servers",
  "dns_list_records",
  "notifications_list",
  "regions_list",
  "tasks_get",
];

const WRITE_TOOLS = [
  "compute_delete_server",
  "compute_set_power",
  "dns_set_records",
  "firewall_set_rules",
  "projects_update",
  "sshkeys_create",
];

beforeEach(async () => {
  state = {};
  api = fixtureApi(state);
  home = await makeHome();
});

afterEach(async () => {
  await connected?.close();
  connected = undefined;
  api.stop();
  await home.cleanup();
});

async function start(allowWrites = false): Promise<ConnectedSession> {
  connected = await connectSession(api, { allowWrites, cacheDirectory: home.cache });
  return connected;
}

async function toolNames(session: ConnectedSession): Promise<string[]> {
  return (await session.client.listTools()).tools.map((tool) => tool.name).sort();
}

describe("the tiers", () => {
  test("the default start lists read tools only", async () => {
    const session = await start();
    expect(await toolNames(session)).toEqual(READ_TOOLS);
  });

  test("--allow-writes adds write tools and the destructive tools that have confirm", async () => {
    const session = await start(true);
    const names = await toolNames(session);
    expect(names).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    expect(names).not.toContain("compute_delete_snapshot");
  });

  test("a destructive tool requires its confirm field", async () => {
    const session = await start(true);
    const tool = (await session.client.listTools()).tools.find(
      (candidate) => candidate.name === "compute_delete_server",
    );
    expect(tool?.inputSchema.required).toContain("confirmHostname");
    expect(tool?.inputSchema.required).toContain("serverId");
  });

  test("a read token lists read tools only, even with --allow-writes", async () => {
    state.scope = "read";
    const session = await start(true);
    expect(await toolNames(session)).toEqual(READ_TOOLS);
    expect(session.client.getInstructions()).toContain("the token's scope is read");
  });

  test("a scope this version does not know lists read tools only, even with --allow-writes", async () => {
    state.scope = "billing_admin";
    const session = await start(true);
    expect(await toolNames(session)).toEqual(READ_TOOLS);
    expect(session.client.getInstructions()).toContain("the token's scope is billing_admin");
  });

  test("a spend tool and its quote tool need --allow-writes and --allow-spend together", async () => {
    state.spec = loadFixture("spend");
    const spendAndQuote = ["compute_create_server", "compute_quote_create_server"];
    const listed = async (allowWrites: boolean, allowSpend: boolean) => {
      const session = await connectSession(api, {
        allowWrites,
        allowSpend,
        cacheDirectory: home.cache,
      });
      try {
        return await toolNames(session);
      } finally {
        await session.close();
      }
    };
    for (const [allowWrites, allowSpend] of [
      [false, false],
      [true, false],
      [false, true],
    ] as const) {
      const names = await listed(allowWrites, allowSpend);
      expect(names).toEqual(["billing_get_quote", "tasks_get"]);
    }
    const both = await listed(true, true);
    expect(both).toEqual(expect.arrayContaining([...spendAndQuote, "billing_get_quote"]));
    state.scope = "read";
    expect(await listed(true, true)).toEqual(["billing_get_quote", "tasks_get"]);
  });

  test("an operation with mcp false is never a tool", async () => {
    const session = await start(true);
    const names = await toolNames(session);
    expect(names.some((name) => name.includes("tags"))).toBe(false);
  });

  test("a feature that is off hides its tools and the instructions say so", async () => {
    state.features = { dns: false };
    const session = await start(true);
    const names = await toolNames(session);
    expect(names.filter((name) => name.startsWith("dns_"))).toEqual([]);
    expect(session.client.getInstructions()).toContain("off for the organization");
    expect(session.client.getInstructions()).toContain(": dns.");
  });
});

describe("the annotations", () => {
  const expected: Record<string, [boolean, boolean, boolean]> = {
    compute_get_server: [true, false, true],
    compute_list_servers: [true, false, true],
    compute_set_power: [false, false, false],
    firewall_set_rules: [false, false, true],
    dns_set_records: [false, false, false],
    compute_delete_server: [false, true, true],
  };

  test("each annotation matches the table of kind and method", async () => {
    const session = await start(true);
    const tools = (await session.client.listTools()).tools;
    for (const [name, [readOnly, destructive, idempotent]] of Object.entries(expected)) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect({ name, ...tool?.annotations }).toEqual({
        name,
        title: tool?.title,
        readOnlyHint: readOnly,
        destructiveHint: destructive,
        idempotentHint: idempotent,
      });
    }
  });

  test("the title is the operation's summary and the schema has no $ref", async () => {
    const session = await start(true);
    const tools = (await session.client.listTools()).tools;
    const remove = tools.find((tool) => tool.name === "compute_delete_server");
    expect(remove?.title).toBe("Delete a server");
    expect(remove?.annotations?.title).toBe("Delete a server");
    for (const tool of tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"\$ref":"#\/components/);
      expect(tool.inputSchema.type).toBe("object");
    }
  });
});

describe("a tool call", () => {
  test("a guard failure is isError with CLI_INVALID_INPUT and sends no request", async () => {
    const session = await start();
    const result = await session.client.callTool({
      name: "compute_get_server",
      arguments: { serverId: "../x" },
    });
    expect(result.isError).toBe(true);
    expect((resultJson(result) as { error: { code: string } }).error.code).toBe(
      "CLI_INVALID_INPUT",
    );
    expect(operationRequests(api.requests)).toEqual([]);
  });

  test("a schema failure is isError with the field in details", async () => {
    const session = await start(true);
    const result = await session.client.callTool({
      name: "compute_delete_server",
      arguments: { serverId: "srv-1" },
    });
    expect(result.isError).toBe(true);
    expect(resultJson(result)).toMatchObject({
      error: {
        code: "CLI_INVALID_INPUT",
        details: [{ field: "confirmHostname", message: "is required" }],
      },
    });
    expect(operationRequests(api.requests)).toEqual([]);
  });

  test("an API error is isError with the mapped error", async () => {
    const session = await start();
    const result = await session.client.callTool({
      name: "compute_get_server",
      arguments: { serverId: "srv-9" },
    });
    expect(result.isError).toBe(true);
    expect(resultJson(result)).toEqual({
      error: {
        status: 404,
        code: "NOT_FOUND",
        message: "Not found",
        timestamp: "2026-10-18T00:00:00Z",
      },
    });
  });

  test("a success is one text item with the JSON answer", async () => {
    const session = await start();
    const result = await session.client.callTool({
      name: "compute_get_server",
      arguments: { serverId: "srv-1" },
    });
    expect(result.isError).toBeUndefined();
    expect(resultJson(result)).toMatchObject({ id: "srv-1", status: "running" });
  });

  test("an async tool returns the 202 body at once and names the task tool", async () => {
    const session = await start(true);
    const result = await session.client.callTool({
      name: "compute_delete_server",
      arguments: { serverId: "srv-1", confirmHostname: "web-1" },
    });
    expect(result.isError).toBeUndefined();
    expect(resultJson(result)).toEqual({ accepted: { taskId: "t-1" }, taskTool: "tasks_get" });
    expect(operationRequests(api.requests)).toEqual(["DELETE /v1/servers/srv-1"]);
    expect(api.requests.at(-1)?.body).toEqual({ confirmHostname: "web-1" });
  });

  test("a paginated tool returns one page with its cursor", async () => {
    const session = await start();
    const first = resultJson(
      await session.client.callTool({ name: "compute_list_servers", arguments: {} }),
    ) as { data: unknown[]; nextCursor: string | null };
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).toBe("c-2");
    const second = resultJson(
      await session.client.callTool({
        name: "compute_list_servers",
        arguments: { cursor: first.nextCursor },
      }),
    ) as { data: unknown[]; nextCursor: string | null };
    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(operationRequests(api.requests)).toEqual([
      "GET /v1/servers",
      "GET /v1/servers?cursor=c-2",
    ]);
  });

  test("a tool that is not registered is CLI_INVALID_INPUT", async () => {
    const session = await start();
    const result = await session.client.callTool({
      name: "compute_set_power",
      arguments: { serverId: "srv-1", action: "start" },
    });
    expect(result.isError).toBe(true);
    expect((resultJson(result) as { error: { code: string } }).error.code).toBe(
      "CLI_INVALID_INPUT",
    );
    expect(operationRequests(api.requests)).toEqual([]);
  });
});

describe("the 5-minute check", () => {
  test("it runs every 5 minutes once the client is initialized", async () => {
    const session = await start();
    expect(session.scheduler.intervals).toEqual([5 * 60 * 1000]);
  });

  test("a new ETag with a new tool sends tools/list_changed once", async () => {
    const session = await start();
    const spec = loadFixture("surface");
    spec.paths["/v1/images"] = {
      get: {
        operationId: "images.list",
        summary: "List images",
        "x-lazco": { cli: "images list", mcp: { name: "images_list" }, kind: "read" },
      },
    };
    state.spec = spec;
    state.etag = '"fixture-2"';
    await session.scheduler.tick();
    await Bun.sleep(20);
    expect(session.listChanged).toBe(1);
    expect(await toolNames(session)).toContain("images_list");
    await session.scheduler.tick();
    await Bun.sleep(20);
    expect(session.listChanged).toBe(1);
  });

  test("a 304 and an unchanged whoami send nothing", async () => {
    const session = await start();
    const before = api.requests.length;
    await session.scheduler.tick();
    await Bun.sleep(20);
    expect(session.listChanged).toBe(0);
    const checks = api.requests.slice(before);
    expect(checks.map((request) => request.path)).toEqual(["/v1/spec", "/v1/whoami"]);
    expect(checks[0]?.headers["if-none-match"]).toBe('"fixture"');
  });

  test("a feature switched off removes its tools", async () => {
    const session = await start();
    expect(await toolNames(session)).toContain("dns_list_records");
    state.features = { dns: false };
    await session.scheduler.tick();
    await Bun.sleep(20);
    expect(session.listChanged).toBe(1);
    expect((await toolNames(session)).filter((name) => name.startsWith("dns_"))).toEqual([]);
  });

  test("a failed check keeps the tools and warns", async () => {
    const session = await start();
    const handler = api.handler;
    api.handler = () => new Response("down", { status: 500 });
    await session.scheduler.tick();
    api.handler = handler;
    expect(session.listChanged).toBe(0);
    expect(await toolNames(session)).toEqual(READ_TOOLS);
    expect(session.warnings.join("\n")).toContain("the tool list could not be checked");
  });

  test("closing the client stops the check", async () => {
    const session = await start();
    await session.close();
    connected = undefined;
    await Bun.sleep(20);
    expect(session.scheduler.stopped).toBe(1);
  });
});

describe("Idempotency-Key in MCP", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  test("the header is no field of the tool's inputSchema", async () => {
    const session = await start(true);
    const tool = (await session.client.listTools()).tools.find(
      (candidate) => candidate.name === "sshkeys_create",
    );
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool?.inputSchema).toLowerCase()).not.toContain("idempotency");
  });

  test("each call of a tool that declares the header sends its own new key", async () => {
    const session = await start(true);
    const arguments_ = { name: "laptop", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5" };
    await session.client.callTool({ name: "sshkeys_create", arguments: arguments_ });
    await session.client.callTool({ name: "sshkeys_create", arguments: arguments_ });
    const keys = api.requests
      .filter((request) => request.method === "POST" && request.path === "/v1/ssh-keys")
      .map((request) => request.headers["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(UUID_V4);
    expect(keys[1]).toMatch(UUID_V4);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("a tool whose operation does not declare it sends none", async () => {
    const session = await start();
    await session.client.callTool({ name: "compute_get_server", arguments: { serverId: "srv-1" } });
    const read = api.requests.find((request) => request.path === "/v1/servers/srv-1");
    expect(read?.headers["idempotency-key"]).toBeUndefined();
  });
});
