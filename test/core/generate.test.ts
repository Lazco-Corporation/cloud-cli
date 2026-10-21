import { describe, expect, test } from "bun:test";
import {
  generateSurface,
  type Operation,
  type SkipReason,
} from "../../src/core/generate/operations";
import { CommandTree, toolOperations } from "../../src/core/generate/tree";
import { createAjv } from "../../src/core/request/ajv";
import { isOpenApiDocument } from "../../src/core/spec/types";
import { FIXTURE_NAMES, loadFixture } from "../helpers/fixtures";

const ajv = createAjv();

function surfaceOf(name: (typeof FIXTURE_NAMES)[number]) {
  return generateSurface(loadFixture(name), ajv);
}

function byCommand(operations: readonly Operation[], command: string): Operation {
  const operation = operations.find((candidate) => candidate.command.join(" ") === command);
  if (!operation) {
    throw new Error(`no command ${command}`);
  }
  return operation;
}

describe("fixtures", () => {
  for (const name of FIXTURE_NAMES) {
    test(`${name} is an OpenAPI 3.1 JSON document`, () => {
      const document = loadFixture(name);
      expect(isOpenApiDocument(document)).toBe(true);
      expect(document.openapi).toMatch(/^3\.1\.\d+$/);
      expect(typeof document.info?.title).toBe("string");
      expect(typeof document.info?.version).toBe("string");
    });
  }
});

describe("skips", () => {
  const expected: Record<(typeof FIXTURE_NAMES)[number], Array<[string, SkipReason]>> = {
    surface: [],
    pages: [],
    artifacts: [],
    spend: [],
    skips: [
      ["teleports.create", "invalid-annotation"],
      ["jobs.create", "invalid-annotation"],
      ["feeds.list", "invalid-annotation"],
      ["labs.pages.deployments.create", "no-uploader"],
      ["records.update", "etag-without-get"],
      ["auth.tokens.list", "reserved-word"],
      ["billing.get", "command-is-group"],
      ["broken.create", "unresolvable-ref"],
    ],
  };
  for (const name of FIXTURE_NAMES) {
    test(`${name} skips exactly what it should`, () => {
      const { skipped } = surfaceOf(name);
      expect(
        skipped
          .map((skip) => [skip.operationId, skip.reason])
          .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
      ).toEqual([...expected[name]].sort((left, right) => left[0].localeCompare(right[0])));
    });
  }

  test("an unknown kind names the allowed values", () => {
    const skip = surfaceOf("skips").skipped.find(
      (entry) => entry.operationId === "teleports.create",
    );
    expect(skip?.message).toContain("x-lazco.kind");
    expect(skip?.message).toContain("read, write, destructive, spend");
  });

  test("the command below a skipped group is kept", () => {
    const { operations } = surfaceOf("skips");
    expect(operations.map((operation) => operation.command.join(" "))).toEqual([
      "billing invoices list",
    ]);
  });

  test("two operations with one command are both skipped", () => {
    const document = loadFixture("surface");
    const regions = document.paths["/v1/regions"]?.get;
    if (!regions) throw new Error("fixture changed");
    regions["x-lazco"] = { cli: "compute list", mcp: false, kind: "read" };
    const { skipped } = generateSurface(document, ajv);
    expect(skipped.map((skip) => [skip.operationId, skip.reason]).sort()).toEqual([
      ["compute.servers.list", "duplicate-command"],
      ["regions.list", "duplicate-command"],
    ]);
  });

  test("positionals follow the order of the path, not of the parameter list", () => {
    const document = loadFixture("surface");
    const snapshotDelete = document.paths["/v1/servers/{serverId}/snapshots/{snapname}"]?.delete;
    if (!snapshotDelete?.parameters) throw new Error("fixture changed");
    snapshotDelete.parameters.reverse();
    const { operations } = generateSurface(document, ajv);
    expect(byCommand(operations, "compute snapshots delete").pathParameters).toEqual([
      "serverId",
      "snapname",
    ]);
  });

  test("two operations with one tool name are both skipped", () => {
    const document = loadFixture("surface");
    const regions = document.paths["/v1/regions"]?.get;
    if (!regions) throw new Error("fixture changed");
    regions["x-lazco"] = {
      cli: "regions list",
      mcp: { name: "compute_list_servers" },
      kind: "read",
    };
    const { skipped } = generateSurface(document, ajv);
    expect(skipped.map((skip) => skip.reason)).toEqual(["duplicate-tool", "duplicate-tool"]);
  });
});

describe("the Idempotency-Key header", () => {
  const { operations } = surfaceOf("surface");

  test("a required header is read as required, and is no input field", () => {
    const create = byCommand(operations, "compute create");
    expect(create.idempotencyKey).toBe("required");
    expect(JSON.stringify(create.inputSchema).toLowerCase()).not.toContain("idempotency");
  });

  test("an optional header is read as optional, and is no input field", () => {
    const sshKeys = byCommand(operations, "ssh-keys create");
    expect(sshKeys.idempotencyKey).toBe("optional");
    expect(JSON.stringify(sshKeys.inputSchema).toLowerCase()).not.toContain("idempotency");
  });

  test("an operation that does not declare it has none", () => {
    expect(byCommand(operations, "compute list").idempotencyKey).toBeNull();
    expect(byCommand(operations, "compute delete").idempotencyKey).toBeNull();
  });

  test("the name is matched without case", () => {
    const document = loadFixture("surface");
    const parameter = document.paths["/v1/servers"]?.post?.parameters?.[0];
    if (!parameter || "$ref" in parameter) throw new Error("fixture changed");
    parameter.name = "idempotency-key";
    const { operations: changed, skipped } = generateSurface(document, ajv);
    expect(skipped).toEqual([]);
    expect(byCommand(changed, "compute create").idempotencyKey).toBe("required");
  });

  test("another required header still skips its operation", () => {
    const document = loadFixture("surface");
    document.paths["/v1/servers"]?.post?.parameters?.push({
      name: "X-Other",
      in: "header",
      required: true,
      schema: { type: "string" },
    });
    const { skipped } = generateSurface(document, ajv);
    expect(skipped.map((skip) => [skip.operationId, skip.reason])).toEqual([
      ["compute.servers.create", "unsupported-parameter"],
    ]);
  });
});

describe("surface", () => {
  const { operations } = surfaceOf("surface");

  test("each exposed operation is one command, and expose false is none", () => {
    expect(operations.map((operation) => operation.command.join(" ")).sort()).toEqual([
      "compute create",
      "compute delete",
      "compute get",
      "compute list",
      "compute power set",
      "compute quote-create",
      "compute snapshots delete",
      "dns records list",
      "dns records set",
      "firewall rules set",
      "notifications list",
      "projects update",
      "regions list",
      "ssh-keys create",
      "tags bulk create",
      "tasks get",
    ]);
  });

  test("every kind comes through", () => {
    expect(new Set(operations.map((operation) => operation.kind))).toEqual(
      new Set(["read", "write", "destructive", "spend"]),
    );
  });

  test("mcp false makes a command and no tool", () => {
    expect(byCommand(operations, "compute create").toolName).toBeNull();
    expect(byCommand(operations, "tags bulk create").toolName).toBeNull();
    const tools = toolOperations(operations).map((operation) => operation.toolName);
    expect(tools).toContain("compute_list_servers");
    expect(tools).not.toContain(null);
    expect(tools).toEqual([...tools].sort());
    expect(tools).toHaveLength(13);
  });

  test("feature, async, confirm, paginate and an unknown key", () => {
    expect(byCommand(operations, "dns records set").feature).toBe("dns");
    expect(byCommand(operations, "compute delete").annotation.async).toBe("task");
    expect(byCommand(operations, "compute delete").annotation.confirm).toBe("confirmHostname");
    expect(byCommand(operations, "compute list").annotation.paginate).toBe("cursor");
    expect(byCommand(operations, "notifications list").annotation.paginate).toBe("page");
    expect(byCommand(operations, "regions list").summary).toBe("List regions");
  });

  test("path, query and body merge into one input object", () => {
    const list = byCommand(operations, "compute list");
    expect(list.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        region: { type: "string" },
        limit: { type: "number" },
        cursor: { type: "string" },
      },
      required: [],
    });
    expect(list.queryParameters).toEqual(["region", "limit", "cursor"]);
    const remove = byCommand(operations, "compute delete");
    expect(remove.pathParameters).toEqual(["serverId"]);
    expect(remove.body).toEqual({ mode: "merged", required: true });
    expect(remove.inputSchema.required).toEqual(["serverId", "confirmHostname"]);
  });

  test("concurrency etag adds ifMatch, and an open body stays open", () => {
    const set = byCommand(operations, "dns records set");
    expect(Object.keys(set.inputSchema.properties as object)).toEqual([
      "zoneId",
      "ifMatch",
      "rrsets",
    ]);
    expect(set.inputSchema.additionalProperties).toBe(true);
    expect(set.inputSchema.required).toEqual(["zoneId", "rrsets"]);
  });

  test("a local $ref is copied in", () => {
    const create = byCommand(operations, "ssh-keys create");
    expect(create.inputSchema).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        publicKey: { type: "string", minLength: 16 },
      },
      required: ["name", "publicKey"],
      additionalProperties: false,
    });
  });

  test("a cyclic $ref stays as $defs", () => {
    const set = byCommand(operations, "firewall rules set");
    expect(set.inputSchema.properties).toMatchObject({
      rules: {
        type: "array",
        items: {
          type: "object",
          properties: { children: { items: { $ref: "#/$defs/RuleNode" } } },
        },
      },
    });
    expect(set.inputSchema.$defs).toMatchObject({
      RuleNode: { properties: { children: { items: { $ref: "#/$defs/RuleNode" } } } },
    });
    const validate = ajv.compile(set.inputSchema);
    expect(
      validate({ firewallId: "f", rules: [{ action: "allow", children: [{ action: "deny" }] }] }),
    ).toBe(true);
    expect(
      validate({ firewallId: "f", rules: [{ action: "allow", children: [{ action: "x" }] }] }),
    ).toBe(false);
  });

  test("a body property that clashes with a parameter moves under body", () => {
    const update = byCommand(operations, "projects update");
    expect(update.body).toEqual({ mode: "wrapped", required: true });
    expect(Object.keys(update.inputSchema.properties as object)).toEqual(["projectId", "body"]);
    expect(update.inputSchema.required).toEqual(["projectId", "body"]);
  });

  test("a body that is not an object moves under body", () => {
    const bulk = byCommand(operations, "tags bulk create");
    expect(bulk.body.mode).toBe("wrapped");
    expect(bulk.inputSchema.properties).toEqual({
      body: { type: "array", items: { type: "string" } },
    });
  });

  test("every input schema compiles", () => {
    for (const operation of operations) {
      expect(() => ajv.compile(operation.inputSchema)).not.toThrow();
    }
  });
});

describe("spend operations and their quotes", () => {
  const { operations } = surfaceOf("spend");
  const spends = operations.filter((operation) => operation.kind === "spend");

  test("every spend operation of the phase C spec is a command linked to its quote operation", () => {
    expect(spends.map((operation) => operation.operationId).sort()).toEqual([
      "compute.autoBackup.set",
      "compute.bandwidthAddons.buy",
      "compute.extraDisk.buy",
      "compute.extraIps.add",
      "compute.renewal.resume",
      "compute.servers.create",
      "compute.servers.reinstall",
      "compute.servers.upgrade",
      "labs.pages.packs.create",
      "labs.pages.sites.buyout",
      "networkResources.renewal.payFromBalance",
      "t4.balance.pay",
    ]);
    for (const spend of spends) {
      expect(spend.quote?.operationId).toBe(spend.annotation.quote as string);
      expect(spend.quote?.kind).toBe("write");
      expect(spend.quote?.isQuote).toBe(true);
      expect(spend.isQuote).toBe(false);
    }
    const quotes = operations.filter((operation) => operation.isQuote);
    expect(quotes).toHaveLength(12);
    expect(byCommand(operations, "billing quotes get").isQuote).toBe(false);
  });

  test("the command input has no quoteId and no expectedAmount, the request input requires both", () => {
    const upgrade = byCommand(operations, "compute upgrade");
    expect(Object.keys(upgrade.commandInputSchema.properties as object)).toEqual([
      "serverId",
      "planSlug",
    ]);
    expect(upgrade.commandInputSchema.required).toEqual(["serverId", "planSlug"]);
    expect(upgrade.inputSchema.required).toEqual([
      "serverId",
      "planSlug",
      "quoteId",
      "expectedAmount",
    ]);
    for (const spend of spends) {
      const command = JSON.stringify(spend.commandInputSchema);
      expect(command).not.toContain("quoteId");
      expect(command).not.toContain("expectedAmount");
      // The quote operation takes what the command takes.
      expect(Object.keys(spend.commandInputSchema.properties as object).sort()).toEqual(
        Object.keys(spend.quote?.inputSchema.properties as object).sort(),
      );
    }
    const quoteCommand = byCommand(operations, "compute quote-upgrade");
    expect(quoteCommand.commandInputSchema).toBe(quoteCommand.inputSchema);
  });

  test("reinstall keeps mcp false on the spend and on its quote", () => {
    expect(byCommand(operations, "compute reinstall").toolName).toBeNull();
    expect(byCommand(operations, "compute quote-reinstall").toolName).toBeNull();
    expect(byCommand(operations, "compute create").toolName).toBe("compute_create_server");
    expect(byCommand(operations, "compute quote-create").toolName).toBe(
      "compute_quote_create_server",
    );
  });

  test("a spend operation without x-lazco.quote is no command", () => {
    const document = loadFixture("spend");
    const upgrade = document.paths["/v1/servers/{serverId}/upgrade"]?.post;
    if (!upgrade) throw new Error("fixture changed");
    const { quote: _quote, ...rest } = upgrade["x-lazco"] as Record<string, unknown>;
    upgrade["x-lazco"] = rest;
    const generated = generateSurface(document, ajv);
    expect(generated.skipped.map((skip) => [skip.operationId, skip.reason])).toEqual([
      ["compute.servers.upgrade", "no-quote"],
    ]);
    expect(generated.operations.map((operation) => operation.command.join(" "))).not.toContain(
      "compute upgrade",
    );
  });

  test("a spend operation whose quote operation is missing is no command", () => {
    const document = loadFixture("spend");
    delete document.paths["/v1/servers/{serverId}/upgrade/quote"];
    const generated = generateSurface(document, ajv);
    expect(generated.skipped).toEqual([
      expect.objectContaining({
        operationId: "compute.servers.upgrade",
        reason: "no-quote",
        message:
          'its quote operation "compute.servers.quote-upgrade" is not in the spec, or is skipped',
      }),
    ]);
  });

  test("a spend operation whose quote operation is skipped is no command, and the quote stays a quote", () => {
    const document = loadFixture("spend");
    const quote = document.paths["/v1/servers/{serverId}/upgrade/quote"]?.post;
    const create = document.paths["/v1/servers"]?.post;
    if (!quote || !create) throw new Error("fixture changed");
    quote["x-lazco"] = { cli: "compute quote-upgrade", kind: "write" };
    // A spend that is skipped for its own reason still marks its quote.
    create.parameters?.push({ name: "X-Other", in: "header", required: true });
    const generated = generateSurface(document, ajv);
    expect(generated.skipped.map((skip) => [skip.operationId, skip.reason]).sort()).toEqual([
      ["compute.servers.create", "unsupported-parameter"],
      ["compute.servers.quote-upgrade", "invalid-annotation"],
      ["compute.servers.upgrade", "no-quote"],
    ]);
    expect(byCommand(generated.operations, "compute quote-create").isQuote).toBe(true);
  });

  test("the quote of a hidden spend operation stays a quote", () => {
    const document = loadFixture("spend");
    const upgrade = document.paths["/v1/servers/{serverId}/upgrade"]?.post;
    if (!upgrade) throw new Error("fixture changed");
    upgrade["x-lazco"] = { ...(upgrade["x-lazco"] as Record<string, unknown>), expose: false };
    const { operations: changed } = generateSurface(document, ajv);
    expect(changed.map((operation) => operation.command.join(" "))).not.toContain(
      "compute upgrade",
    );
    expect(byCommand(changed, "compute quote-upgrade").isQuote).toBe(true);
  });

  test("a spend operation whose body does not require both quote fields is no command", () => {
    const document = loadFixture("spend");
    const schema = document.paths["/v1/servers/{serverId}/upgrade"]?.post?.requestBody?.content?.[
      "application/json"
    ]?.schema as { required: string[] } | undefined;
    if (!schema) throw new Error("fixture changed");
    schema.required = schema.required.filter((name) => name !== "expectedAmount");
    const generated = generateSurface(document, ajv);
    expect(generated.skipped).toEqual([
      expect.objectContaining({
        operationId: "compute.servers.upgrade",
        reason: "unsupported-body",
      }),
    ]);
  });

  for (const kind of ["read", "destructive"] as const) {
    test(`a quote operation of kind ${kind} is refused`, () => {
      const document = loadFixture("spend");
      const quote = document.paths["/v1/servers/{serverId}/upgrade/quote"]?.post;
      if (!quote) throw new Error("fixture changed");
      (quote["x-lazco"] as Record<string, unknown>).kind = kind;
      const generated = generateSurface(document, ajv);
      expect(generated.skipped).toEqual([
        expect.objectContaining({
          operationId: "compute.servers.upgrade",
          reason: "no-quote",
          message: `its quote operation "compute.servers.quote-upgrade" is ${kind}, not write`,
        }),
      ]);
    });
  }

  test("a quote name that points at a read operation never hides that read operation", () => {
    const document = loadFixture("spend");
    const upgrade = document.paths["/v1/servers/{serverId}/upgrade"]?.post;
    if (!upgrade) throw new Error("fixture changed");
    (upgrade["x-lazco"] as Record<string, unknown>).quote = "billing.quotes.get";
    const generated = generateSurface(document, ajv);
    expect(generated.skipped.map((skip) => skip.operationId)).toEqual(["compute.servers.upgrade"]);
    expect(byCommand(generated.operations, "billing quotes get").isQuote).toBe(false);
  });

  test("a spend operation that does not require Idempotency-Key is no command", () => {
    const document = loadFixture("spend");
    const upgrade = document.paths["/v1/servers/{serverId}/upgrade"]?.post;
    const header = upgrade?.parameters?.find(
      (parameter) => "name" in parameter && parameter.name === "Idempotency-Key",
    );
    if (!header || "$ref" in header) throw new Error("fixture changed");
    header.required = false;
    expect(generateSurface(document, ajv).skipped).toEqual([
      expect.objectContaining({
        operationId: "compute.servers.upgrade",
        reason: "unsupported-parameter",
      }),
    ]);
  });

  test("a quote field that is a parameter, not a body property, is refused", () => {
    const document = loadFixture("spend");
    const upgrade = document.paths["/v1/servers/{serverId}/upgrade"]?.post;
    const schema = upgrade?.requestBody?.content?.["application/json"]?.schema as
      | { properties: Record<string, unknown>; required: string[] }
      | undefined;
    if (!upgrade?.parameters || !schema) throw new Error("fixture changed");
    delete schema.properties.quoteId;
    schema.required = schema.required.filter((name) => name !== "quoteId");
    upgrade.parameters.push({
      name: "quoteId",
      in: "query",
      required: true,
      schema: { type: "string" },
    });
    expect(generateSurface(document, ajv).skipped).toEqual([
      expect.objectContaining({
        operationId: "compute.servers.upgrade",
        reason: "unsupported-body",
      }),
    ]);
  });

  test("a spend without a usable quote never makes another operation a duplicate", () => {
    const document = loadFixture("spend");
    delete document.paths["/v1/servers/{serverId}/upgrade/quote"];
    const quote = document.paths["/v1/servers/{serverId}/extra-ips/quote"]?.post;
    if (!quote) throw new Error("fixture changed");
    // The extra IP quote now shares its command with the upgrade, which is dropped first.
    (quote["x-lazco"] as Record<string, unknown>).cli = "compute upgrade";
    const generated = generateSurface(document, ajv);
    expect(generated.skipped.map((skip) => [skip.operationId, skip.reason])).toEqual([
      ["compute.servers.upgrade", "no-quote"],
    ]);
    expect(byCommand(generated.operations, "compute upgrade").operationId).toBe(
      "compute.extraIps.quote-add",
    );
  });

  test("a quote operation that is a spend operation itself is refused", () => {
    const document = loadFixture("spend");
    const upgrade = document.paths["/v1/servers/{serverId}/upgrade"]?.post;
    if (!upgrade) throw new Error("fixture changed");
    (upgrade["x-lazco"] as Record<string, unknown>).quote = "compute.servers.create";
    const generated = generateSurface(document, ajv);
    expect(generated.skipped).toEqual([
      expect.objectContaining({ operationId: "compute.servers.upgrade", reason: "no-quote" }),
    ]);
  });
});

describe("command tree", () => {
  const tree = new CommandTree(surfaceOf("surface").operations);

  test("the longest command wins and the rest are positionals", () => {
    const resolution = tree.resolve(["compute", "delete", "srv-1"]);
    expect(resolution.kind).toBe("command");
    if (resolution.kind === "command") {
      expect(resolution.entry.operationId).toBe("compute.servers.delete");
      expect(resolution.consumed).toBe(2);
    }
  });

  test("a group names its children", () => {
    expect(tree.resolve(["compute"])).toEqual({
      kind: "group",
      group: ["compute"],
      children: ["create", "delete", "get", "list", "power", "quote-create", "snapshots"],
    });
  });

  test("an unknown word is unknown", () => {
    expect(tree.resolve(["nothing"]).kind).toBe("unknown");
  });
});
