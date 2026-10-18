import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HandwrittenCommand } from "../../src/commands/types";
import { cliEnv, makeHome, ndjson, runInProcess, runLazco } from "../helpers/cli";
import type { FakeApi } from "../helpers/fakeApi";
import { fixtureApi } from "../helpers/fixtureApi";

let api: FakeApi;
let home: Awaited<ReturnType<typeof makeHome>>;

beforeEach(async () => {
  api = fixtureApi();
  home = await makeHome();
});

afterEach(async () => {
  api.stop();
  await home.cleanup();
});

/** Two hand-written commands shaped like the ones of `cli-auth` and `cli-mcp`. */
const HANDWRITTEN: HandwrittenCommand[] = [
  {
    command: ["auth", "login"],
    summary: "Sign in",
    kind: "write",
    positionals: [],
    inputSchema: {
      type: "object",
      properties: { withToken: { type: "boolean", description: "Read the token from stdin" } },
      additionalProperties: false,
    },
    run: async (input) => ({ record: { signedIn: true, input } }),
  },
  {
    command: ["mcp", "install"],
    summary: "Add lazco to an MCP client",
    kind: "write",
    positionals: [],
    inputSchema: {
      type: "object",
      required: ["client"],
      properties: { client: { enum: ["pi", "cursor"] } },
      additionalProperties: false,
    },
    run: async () => ({ record: {} }),
  },
];

describe("--describe", () => {
  test("one command prints its operation and its input schema", async () => {
    const run = await runLazco(
      ["--api-url", api.apiUrl, "compute", "create", "--describe"],
      cliEnv(home.home),
    );
    expect(run.code).toBe(0);
    const described = JSON.parse(run.stdout);
    expect(described).toMatchObject({
      command: "compute create",
      summary: "Create a server",
      operationId: "compute.servers.create",
      method: "POST",
      path: "/v1/servers",
      kind: "spend",
      async: "task",
      concurrency: null,
      paginate: null,
      confirm: null,
      feature: null,
      mcpTool: null,
      positionals: [],
      flags: { "--hostname": "hostname", "--region-slug": "regionSlug", "--ssh-keys": "sshKeys" },
    });
    expect(described.inputSchema.type).toBe("object");
    expect(described.inputSchema.required).toContain("regionSlug");
    expect(Object.keys(described.flags)).not.toContain("--cloud-init");
  });

  test("an etag command names its tool and its ifMatch input", async () => {
    const run = await runLazco(
      ["--api-url", api.apiUrl, "dns", "records", "set", "--describe"],
      cliEnv(home.home),
    );
    const described = JSON.parse(run.stdout);
    expect(described).toMatchObject({
      concurrency: "etag",
      mcpTool: "dns_set_records",
      feature: "dns",
      positionals: ["zoneId"],
    });
    expect(described.inputSchema.properties.ifMatch.type).toBe("string");
    expect(described.flags["--if-match"]).toBe("ifMatch");
  });

  test("lazco --describe lists every command, with no credential and no whoami", async () => {
    const run = await runLazco(["--api-url", api.apiUrl, "--describe"], cliEnv(home.home));
    expect(run.code).toBe(0);
    const lines = ndjson(run.stdout) as Array<{ command: string; summary: string; kind: string }>;
    expect(lines).toHaveLength(15);
    for (const line of lines) {
      expect(Object.keys(line)).toEqual(["command", "summary", "kind"]);
    }
    expect(lines.find((line) => line.command === "compute delete")).toEqual({
      command: "compute delete",
      summary: "Delete a server",
      kind: "destructive",
    });
    expect(api.requests.map((request) => request.path)).toEqual(["/v1/spec"]);
  });

  test("a group describes the commands below it", async () => {
    const run = await runLazco(["--api-url", api.apiUrl, "dns", "--describe"], cliEnv(home.home));
    expect((ndjson(run.stdout) as Array<{ command: string }>).map((line) => line.command)).toEqual([
      "dns records list",
      "dns records set",
    ]);
  });

  test("the hand-written commands are listed and described too", async () => {
    const env = cliEnv(home.home);
    const all = await runInProcess(["--api-url", api.apiUrl, "--describe"], {
      env,
      handwritten: HANDWRITTEN,
    });
    const commands = (ndjson(all.stdout) as Array<{ command: string }>).map((line) => line.command);
    expect(commands).toContain("auth login");
    expect(commands).toContain("mcp install");
    expect(commands).toHaveLength(17);

    const one = await runInProcess(["mcp", "install", "--describe"], {
      env,
      handwritten: HANDWRITTEN,
    });
    expect(JSON.parse(one.stdout)).toMatchObject({
      command: "mcp install",
      operationId: null,
      method: null,
      kind: "write",
      mcpTool: null,
      flags: { "--client": "client" },
      inputSchema: { required: ["client"], properties: { client: { enum: ["pi", "cursor"] } } },
    });
  });

  test("a hand-written command runs with its flags and needs no spec", async () => {
    const env = cliEnv(home.home);
    const before = api.requests.length;
    const run = await runInProcess(["auth", "login", "--with-token"], {
      env,
      handwritten: HANDWRITTEN,
    });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ signedIn: true, input: { withToken: true } });
    expect(api.requests.length).toBe(before);
  });
});
