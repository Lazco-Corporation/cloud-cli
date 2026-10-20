import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Operation } from "../../src/core/generate/operations";
import {
  API_URL,
  BUILT_CLI,
  cliEnvironment,
  READ_TOKEN,
  stagingFeatures,
  stagingOperations,
  temporaryHome,
  WRITE_TOKEN,
} from "./staging";

const TIMEOUT_MS = 120_000;

const operations = await stagingOperations();
const features = await stagingFeatures(READ_TOKEN);
let home: Awaited<ReturnType<typeof temporaryHome>>;
let client: Client | undefined;

beforeAll(async () => {
  home = await temporaryHome();
});

afterEach(async () => {
  await client?.close();
  client = undefined;
});

afterAll(async () => {
  await home.cleanup();
});

async function connect(token: string, args: readonly string[] = []): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [BUILT_CLI, "--api-url", API_URL, "mcp", ...args],
    env: cliEnvironment(home.home, token),
    stderr: "ignore",
  });
  client = new Client({ name: "lazco-contract", version: "1" });
  await client.connect(transport);
  return client;
}

function featureOn(operation: Operation): boolean {
  return operation.feature === null || features[operation.feature] !== false;
}

/** The tool names a tier should list, from the staging spec and the organization's features. */
function expectedTools(kinds: ReadonlySet<string>): string[] {
  return operations
    .filter(
      (operation) =>
        operation.toolName !== null &&
        !operation.isQuote &&
        featureOn(operation) &&
        kinds.has(operation.kind) &&
        (operation.kind !== "destructive" || operation.annotation.confirm !== undefined),
    )
    .map((operation) => operation.toolName as string)
    .sort();
}

async function listedNames(session: Client): Promise<string[]> {
  return (await session.listTools()).tools.map((tool) => tool.name).sort();
}

/** The spend tools and their quote tools, which only --allow-writes --allow-spend adds. */
const spendTools = operations
  .filter((operation) => operation.kind === "spend" && operation.toolName !== null)
  .flatMap((operation) => [operation.toolName as string, operation.quote?.toolName ?? ""])
  .filter(Boolean);

/** The spend tools and quote tools of the features the organization has on, in pairs. */
const reachableSpendTools = operations
  .filter(
    (operation) =>
      operation.kind === "spend" &&
      operation.toolName !== null &&
      featureOn(operation) &&
      operation.quote !== null &&
      operation.quote.toolName !== null &&
      featureOn(operation.quote),
  )
  .flatMap((operation) => [operation.toolName as string, operation.quote?.toolName as string]);

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "null";
}

describe("the MCP tiers on staging", () => {
  test(
    "the default start lists every read tool and nothing else",
    async () => {
      const session = await connect(WRITE_TOKEN);
      const tools = (await session.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual(expectedTools(new Set(["read"])));
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
      expect(session.getInstructions()).toContain("CLI Contract Test");
      expect(session.getInstructions()).toContain("read only");
    },
    TIMEOUT_MS,
  );

  test(
    "--allow-writes with the read_write token adds write tools and confirmed destructive ones",
    async () => {
      const session = await connect(WRITE_TOKEN, ["--allow-writes"]);
      const names = await listedNames(session);
      expect(names).toEqual(expectedTools(new Set(["read", "write", "destructive"])));
      expect(names).toContain("ssh_keys_create");
      for (const name of spendTools) {
        expect(names).not.toContain(name);
      }
      const unconfirmed = operations.filter(
        (operation) =>
          operation.kind === "destructive" &&
          operation.annotation.confirm === undefined &&
          operation.toolName !== null,
      );
      expect(unconfirmed.length).toBeGreaterThan(0);
      for (const operation of unconfirmed) {
        expect(names).not.toContain(operation.toolName as string);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "--allow-writes --allow-spend adds each spend tool with its quote tool, a quote tool quotes, and a spend tool without a quote sends nothing",
    async () => {
      const session = await connect(WRITE_TOKEN, ["--allow-writes", "--allow-spend"]);
      expect(await listedNames(session)).toEqual(
        [
          ...expectedTools(new Set(["read", "write", "destructive"])),
          ...reachableSpendTools,
        ].sort(),
      );
      expect(reachableSpendTools).toContain("labs_pages_create_pack");
      expect(reachableSpendTools).toContain("labs_pages_quote_create_pack");

      const quoted = await session.callTool({
        name: "labs_pages_quote_create_pack",
        arguments: {},
      });
      expect(quoted.isError).toBeUndefined();
      const quote = JSON.parse(resultText(quoted)) as { quoteId: string; operationId: string };
      expect(quote.operationId).toBe("labs.pages.packs.create");

      const refused = await session.callTool({ name: "labs_pages_create_pack", arguments: {} });
      expect(refused.isError).toBe(true);
      expect(JSON.parse(resultText(refused)).error.code).toBe("CLI_INVALID_INPUT");

      const stored = await session.callTool({
        name: "billing_get_quote",
        arguments: { quoteId: quote.quoteId },
      });
      expect(stored.isError).toBeUndefined();
      expect(JSON.parse(resultText(stored)).status).toBe("open");
    },
    TIMEOUT_MS,
  );

  test(
    "the read token lists read tools only, even with --allow-writes --allow-spend",
    async () => {
      const session = await connect(READ_TOKEN, ["--allow-writes", "--allow-spend"]);
      expect(await listedNames(session)).toEqual(expectedTools(new Set(["read"])));
      expect(session.getInstructions()).toContain("the token's scope is read");
    },
    TIMEOUT_MS,
  );

  test(
    "a feature that is off hides its tools and the instructions name it",
    async () => {
      const off = Object.entries(features)
        .filter(([, enabled]) => enabled === false)
        .map(([name]) => name)
        .filter((name) =>
          operations.some((operation) => operation.feature === name && operation.toolName !== null),
        );
      const session = await connect(WRITE_TOKEN);
      const names = await listedNames(session);
      for (const name of off) {
        expect(session.getInstructions()).toContain(name);
        const hidden = operations.filter(
          (operation) => operation.feature === name && operation.toolName !== null,
        );
        for (const operation of hidden) {
          expect(names).not.toContain(operation.toolName as string);
        }
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a tool call reads the organization",
    async () => {
      const session = await connect(READ_TOKEN);
      const result = await session.callTool({ name: "whoami", arguments: {} });
      expect(result.isError).toBeUndefined();
      const content = result.content as Array<{ type: string; text: string }>;
      const whoami = JSON.parse(content[0]?.text ?? "null");
      expect(whoami.organization.name).toBe("CLI Contract Test");
      expect(whoami.principal.scope).toBe("read");
      expect(content[0]?.text).not.toContain(READ_TOKEN);
    },
    TIMEOUT_MS,
  );

  test(
    "a guard failure is isError with CLI_INVALID_INPUT",
    async () => {
      const session = await connect(READ_TOKEN);
      const result = await session.callTool({
        name: "compute_get_server",
        arguments: { serverId: "../whoami" },
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0]?.text ?? "null").error.code).toBe("CLI_INVALID_INPUT");
    },
    TIMEOUT_MS,
  );
});
