import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OpenApiDocument } from "../../src/core/spec/types";
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

/** Gives one operation of a fixture another command path. */
function setCommand(spec: OpenApiDocument, path: string, method: string, cli: string): void {
  const operation = (spec.paths[path] as Record<string, { "x-lazco": { cli: string } }>)[method];
  if (!operation) {
    throw new Error(`the fixture has no ${method} ${path}`);
  }
  operation["x-lazco"].cli = cli;
}

describe("--only", () => {
  async function startOnly(
    only: string[][],
    options: { allowWrites?: boolean; allowSpend?: boolean } = {},
  ): Promise<ConnectedSession> {
    connected = await connectSession(api, { ...options, only, cacheDirectory: home.cache });
    return connected;
  }

  test("only the tools under a prefix, by whole words, and the task reader of an async tool", async () => {
    const spec = loadFixture("surface");
    setCommand(spec, "/v1/notifications", "get", "computex list");
    state.spec = spec;
    const session = await startOnly([["compute"]], { allowWrites: true });
    expect(await toolNames(session)).toEqual([
      "compute_delete_server",
      "compute_get_server",
      "compute_list_servers",
      "compute_set_power",
      "tasks_get",
    ]);
    const tool = (await session.client.listTools()).tools.find(
      (candidate) => candidate.name === "compute_delete_server",
    );
    expect(tool?.description).toContain("Read the task with tasks_get");
  });

  test("it never adds a tool, and with no async tool there is no task reader", async () => {
    const session = await startOnly([["compute"]]);
    expect(await toolNames(session)).toEqual(["compute_get_server", "compute_list_servers"]);
  });

  test("a read token lists only the read tools of the prefix, even with --allow-writes", async () => {
    state.scope = "read";
    const session = await startOnly([["compute"]], { allowWrites: true });
    expect(await toolNames(session)).toEqual(["compute_get_server", "compute_list_servers"]);
  });

  test("a prefix whose tools the session cannot use still starts", async () => {
    state.scope = "read";
    const session = await startOnly([["dns", "records", "set"]], { allowWrites: true });
    expect(await toolNames(session)).toEqual([]);
  });

  test("a spend tool keeps its quote tool outside the prefix, and billing_get_quote stays out", async () => {
    const spec = loadFixture("spend");
    setCommand(spec, "/v1/labs/pages/packs/quote", "post", "billing pages-packs quote-create");
    state.spec = spec;
    const session = await startOnly([["labs", "pages"]], { allowWrites: true, allowSpend: true });
    expect(await toolNames(session)).toEqual([
      "labs_pages_buyout_site",
      "labs_pages_create_pack",
      "labs_pages_quote_buyout_site",
      "labs_pages_quote_create_pack",
    ]);
  });

  test("an async spend tool keeps the task reader", async () => {
    state.spec = loadFixture("spend");
    const session = await startOnly([["compute", "create"]], {
      allowWrites: true,
      allowSpend: true,
    });
    expect(await toolNames(session)).toEqual([
      "compute_create_server",
      "compute_quote_create_server",
      "tasks_get",
    ]);
  });

  test("the instructions name the prefixes and only the hidden features inside them", async () => {
    state.features = { dns: false };
    const session = await startOnly([["compute"], ["notifications"]]);
    const instructions = session.client.getInstructions() ?? "";
    expect(instructions).toContain(
      "This session offers only the tools under: compute, notifications. A start without --only offers every tool.",
    );
    expect(instructions).not.toContain("off for the organization");
  });

  test("a hidden feature inside a prefix is named", async () => {
    state.features = { dns: false };
    const session = await startOnly([["dns"]]);
    expect(await toolNames(session)).toEqual([]);
    expect(session.client.getInstructions()).toContain(": dns.");
  });

  test("a session without --only says nothing about it", async () => {
    const session = await start();
    expect(session.client.getInstructions()).not.toContain("--only");
  });

  test("a prefix that matches no command fails the start with CLI_INVALID_INPUT", async () => {
    const started = connectSession(api, {
      only: [["compute"], ["compute", "artefacts"]],
      cacheDirectory: home.cache,
    });
    await expect(started).rejects.toMatchObject({
      code: "CLI_INVALID_INPUT",
      message: expect.stringContaining('"compute artefacts"'),
      details: [
        { field: "only", message: '"compute artefacts" matches no command with an MCP tool' },
      ],
    });
  });

  test("a prefix whose commands have no MCP tool fails the start", async () => {
    const started = connectSession(api, { only: [["tags", "bulk"]], cacheDirectory: home.cache });
    await expect(started).rejects.toMatchObject({ code: "CLI_INVALID_INPUT" });
  });

  test("a hidden feature of a kept spend tool's quote tool is named", async () => {
    const spec = loadFixture("spend");
    const quote = (
      spec.paths["/v1/labs/pages/packs/quote"] as Record<
        string,
        Record<string, Record<string, unknown>>
      >
    ).post;
    if (!quote) {
      throw new Error("the fixture has no pack quote");
    }
    (quote["x-lazco"] as Record<string, unknown>).feature = "quotes";
    state.spec = spec;
    state.features = { quotes: false };
    const session = await startOnly([["labs", "pages", "packs"]], {
      allowWrites: true,
      allowSpend: true,
    });
    expect(await toolNames(session)).toEqual([]);
    expect(session.client.getInstructions()).toContain(": quotes.");
  });

  test("a later spec that drops a prefix warns once and replaces the tools", async () => {
    const session = await startOnly([["compute"], ["notifications"]]);
    expect(await toolNames(session)).toContain("notifications_list");
    const spec = loadFixture("surface");
    setCommand(spec, "/v1/notifications", "get", "alerts list");
    state.spec = spec;
    state.etag = '"fixture-2"';
    await session.scheduler.tick();
    await Bun.sleep(20);
    expect(session.listChanged).toBe(1);
    expect(await toolNames(session)).toEqual(["compute_get_server", "compute_list_servers"]);
    state.etag = '"fixture-3"';
    await session.scheduler.tick();
    await Bun.sleep(20);
    const dropped = session.warnings.filter((warning) =>
      warning.includes('--only "notifications"'),
    );
    expect(dropped).toEqual([
      'warning: --only "notifications" matches no command with an MCP tool any more, so it offers no tool',
    ]);
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
