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

describe("surface", () => {
  const { operations } = surfaceOf("surface");

  test("each exposed operation is one command, and expose false is none", () => {
    expect(operations.map((operation) => operation.command.join(" ")).sort()).toEqual([
      "compute create",
      "compute delete",
      "compute get",
      "compute list",
      "compute power set",
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
      children: ["create", "delete", "get", "list", "power", "snapshots"],
    });
  });

  test("an unknown word is unknown", () => {
    expect(tree.resolve(["nothing"]).kind).toBe("unknown");
  });
});
