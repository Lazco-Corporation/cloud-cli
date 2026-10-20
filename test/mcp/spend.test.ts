import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { FAKE_TOKEN, makeHome } from "../helpers/cli";
import { type FakeApi, json } from "../helpers/fakeApi";
import {
  type ConnectedSession,
  connectSession,
  type ElicitationAnswer,
  resultJson,
} from "../helpers/mcp";
import { quoteBody } from "../helpers/quotes";
import { type SpendState, sentRoutes, spendApi, upgradeQuote } from "../helpers/spendApi";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Every spend tool of the phase C spec and its quote tool. Reinstall has `mcp: false`. */
const SPEND_TOOLS: ReadonlyArray<[string, string]> = [
  ["compute_add_extra_ip", "compute_quote_add_extra_ip"],
  ["compute_buy_bandwidth_addon", "compute_quote_buy_bandwidth_addon"],
  ["compute_buy_extra_disk", "compute_quote_buy_extra_disk"],
  ["compute_create_server", "compute_quote_create_server"],
  ["compute_resume_renewal", "compute_quote_resume_renewal"],
  ["compute_set_auto_backup", "compute_quote_set_auto_backup"],
  ["compute_upgrade_server", "compute_quote_upgrade_server"],
  ["labs_pages_buyout_site", "labs_pages_quote_buyout_site"],
  ["labs_pages_create_pack", "labs_pages_quote_create_pack"],
  [
    "network_resources_pay_from_balance_renewal",
    "network_resources_quote_pay_from_balance_renewal",
  ],
  ["t4_pay_balance", "t4_quote_pay_balance"],
];
const READ_TOOLS = ["billing_get_quote", "tasks_get"];

let state: SpendState;
let api: FakeApi;
let home: Awaited<ReturnType<typeof makeHome>>;
let connected: ConnectedSession | undefined;

beforeEach(async () => {
  state = { quote: upgradeQuote() };
  api = spendApi(state);
  home = await makeHome();
});

afterEach(async () => {
  await connected?.close();
  connected = undefined;
  api.stop();
  await home.cleanup();
});

async function start(
  flags: { allowWrites?: boolean; allowSpend?: boolean; elicitation?: ElicitationAnswer } = {
    allowWrites: true,
    allowSpend: true,
  },
): Promise<ConnectedSession> {
  connected = await connectSession(api, { ...flags, cacheDirectory: home.cache });
  return connected;
}

async function toolNames(session: ConnectedSession): Promise<string[]> {
  return (await session.client.listTools()).tools.map((tool) => tool.name).sort();
}

const UPGRADE = { serverId: "srv-1", planSlug: "s2", quoteId: "q-up", expectedAmount: "100.000" };

function spends() {
  return api.requests.filter(
    (request) => request.method === "POST" && request.path === "/v1/servers/srv-1/upgrade",
  );
}

describe("the spend tier", () => {
  test("--allow-writes --allow-spend lists every spend tool with its quote tool, and no reinstall", async () => {
    const session = await start();
    expect(await toolNames(session)).toEqual(
      [...READ_TOOLS, ...SPEND_TOOLS.flat()].sort((left, right) => left.localeCompare(right)),
    );
  });

  for (const [label, flags] of [
    ["the default start", {}],
    ["--allow-writes alone", { allowWrites: true }],
    ["--allow-spend alone", { allowSpend: true }],
  ] as const) {
    test(`${label} lists no spend tool and no quote tool, and lists billing_get_quote`, async () => {
      const session = await start(flags);
      expect(await toolNames(session)).toEqual(READ_TOOLS);
    });
  }

  test("a feature that is off hides the spend tool and its quote tool together", async () => {
    const session = await start();
    const names = await toolNames(session);
    expect(names).toContain("labs_pages_create_pack");
    await session.close();
    connected = undefined;
    api.handler = (
      (handler) => (request) =>
        request.path === "/v1/whoami"
          ? json(200, {
              organization: { id: "org-1", name: "Spend Org" },
              principal: { kind: "api_token", scope: "read_write" },
              features: { pages: false },
            })
          : handler(request)
    )(api.handler);
    const hidden = await toolNames(await start());
    expect(hidden.filter((name) => name.startsWith("labs_pages_"))).toEqual([]);
    expect(hidden).toContain("compute_create_server");
  });

  test("a quote tool is never listed without its spend tool", async () => {
    const spec = (await (await fetch(`${api.apiUrl}/spec`)).json()) as {
      paths: Record<string, Record<string, { "x-lazco": Record<string, unknown> }>>;
    };
    const upgrade = spec.paths["/v1/servers/{serverId}/upgrade"]?.post;
    if (!upgrade) throw new Error("fixture changed");
    upgrade["x-lazco"].mcp = false;
    const handler = api.handler;
    api.handler = (request) =>
      request.path === "/v1/spec"
        ? json(200, spec, { etag: '"no-upgrade-tool"' })
        : handler(request);
    const names = await toolNames(await start());
    expect(names).not.toContain("compute_upgrade_server");
    expect(names).not.toContain("compute_quote_upgrade_server");
    expect(names).toContain("compute_quote_create_server");
  });

  test("the instructions say spend tools take money and a quote is good for 10 minutes and one spend", async () => {
    const session = await start();
    const instructions = session.client.getInstructions() ?? "";
    expect(instructions).toContain("Spend tools take money from the account balance");
    expect(instructions).toContain("10 minutes and for one spend");
    await session.close();
    connected = undefined;
    const writesOnly = await start({ allowWrites: true });
    expect(writesOnly.client.getInstructions()).toContain("--allow-writes --allow-spend");
  });
});

describe("a spend tool", () => {
  test("carries the spend annotations and names its quote tool", async () => {
    const session = await start();
    const tools = (await session.client.listTools()).tools;
    for (const [spend, quote] of SPEND_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === spend);
      expect({ spend, ...tool?.annotations }).toEqual({
        spend,
        title: tool?.title,
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      });
      expect(tool?.description).toContain(`First call ${quote}`);
      expect(tool?.description).toContain("show its quote to the user");
      expect(tool?.description).toContain("get a yes");
      expect(tool?.inputSchema.required).toEqual(
        expect.arrayContaining(["quoteId", "expectedAmount"]),
      );
      const quoteTool = tools.find((candidate) => candidate.name === quote);
      expect(quoteTool?.annotations?.readOnlyHint).toBe(false);
      expect(quoteTool?.annotations?.destructiveHint).toBe(false);
      // The quote tool takes the spend tool's inputs, less the quote fields.
      expect(Object.keys(quoteTool?.inputSchema.properties ?? {}).sort()).toEqual(
        Object.keys(tool?.inputSchema.properties ?? {})
          .filter((name) => name !== "quoteId" && name !== "expectedAmount")
          .sort(),
      );
    }
  });

  test("a call without a quote is CLI_INVALID_INPUT and the API receives nothing", async () => {
    const session = await start();
    const result = await session.client.callTool({ name: "labs_pages_create_pack", arguments: {} });
    expect(result.isError).toBe(true);
    expect(resultJson(result)).toMatchObject({ error: { code: "CLI_INVALID_INPUT" } });
    expect(sentRoutes(api)).toEqual([]);
  });

  test("quote, then spend, buys one pack with the quoted amount and a new key", async () => {
    state.quote = quoteBody({ quoteId: "q-pack", amount: "52.500" });
    const session = await start();
    const quoted = resultJson(
      await session.client.callTool({ name: "labs_pages_quote_create_pack", arguments: {} }),
    ) as { quoteId: string; amount: string };
    expect(quoted as unknown).toEqual(quoteBody({ quoteId: "q-pack", amount: "52.500" }));
    const result = await session.client.callTool({
      name: "labs_pages_create_pack",
      arguments: { quoteId: quoted.quoteId, expectedAmount: quoted.amount },
    });
    expect(result.isError).toBeUndefined();
    expect(resultJson(result)).toEqual({ id: "pack-1", status: "active" });
    expect(sentRoutes(api)).toEqual([
      "POST /v1/labs/pages/packs/quote",
      "POST /v1/labs/pages/packs",
    ]);
    const spend = api.requests.at(-1);
    expect(spend?.body).toEqual({ quoteId: "q-pack", expectedAmount: "52.500" });
    expect(spend?.headers["idempotency-key"]).toMatch(UUID_V4);
  });

  test("without elicitation a valid quote spends without a question", async () => {
    const session = await start();
    const result = await session.client.callTool({
      name: "compute_upgrade_server",
      arguments: UPGRADE,
    });
    expect(result.isError).toBeUndefined();
    expect(sentRoutes(api)).toEqual(["POST /v1/servers/srv-1/upgrade"]);
    expect(session.elicitations).toEqual([]);
  });

  test("a QUOTE_ error reaches the model with its code and fields, and no new quote is asked", async () => {
    state.spendAnswer = () =>
      json(409, { error: "Conflict", code: "QUOTE_EXPIRED", quoteId: "q-up", amount: "100.000" });
    const session = await start();
    const result = await session.client.callTool({
      name: "compute_upgrade_server",
      arguments: UPGRADE,
    });
    expect(result.isError).toBe(true);
    expect(resultJson(result)).toMatchObject({
      error: { status: 409, code: "QUOTE_EXPIRED", quoteId: "q-up", amount: "100.000" },
    });
    expect(sentRoutes(api)).toEqual(["POST /v1/servers/srv-1/upgrade"]);
  });
});

describe("elicitation", () => {
  const accept: ElicitationAnswer = () => ({ action: "accept", content: { confirm: true } });

  test("the user accepts: the question shows the API's quote, then the spend is sent", async () => {
    const session = await start({ allowWrites: true, allowSpend: true, elicitation: accept });
    const result = await session.client.callTool({
      name: "compute_upgrade_server",
      arguments: UPGRADE,
    });
    expect(result.isError).toBeUndefined();
    expect(sentRoutes(api)).toEqual([
      "GET /v1/billing/quotes/q-up",
      "POST /v1/servers/srv-1/upgrade",
    ]);
    const [message] = session.elicitations;
    expect(message).toContain("spend NT$100 from the account balance?");
    expect(message).toContain("Plan s1 to s2, 12 days: NT$100");
    expect(message).toContain("period: 2026-10-20T00:00:00.000Z to 2026-11-01T00:00:00.000Z");
    expect(message).toContain("then NT$250 every 30 days");
    expect(message).toContain("account balance: NT$1000");
    expect(message).toContain("expires at 2026-10-20T00:10:00.000Z");
    expect(spends()[0]?.body).toEqual({
      planSlug: "s2",
      quoteId: "q-up",
      expectedAmount: "100.000",
    });
  });

  test("the question asks one required boolean with no default", async () => {
    let schema: unknown;
    const session = await start({ allowWrites: true, allowSpend: true, elicitation: accept });
    session.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      schema = (request.params as { requestedSchema?: unknown }).requestedSchema;
      return { action: "accept", content: { confirm: true } };
    });
    await session.client.callTool({ name: "compute_upgrade_server", arguments: UPGRADE });
    expect(schema).toEqual({
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          title: "Spend from the account balance",
          description: "Yes spends NT$100 from the account balance",
        },
      },
      required: ["confirm"],
    });
  });

  for (const [label, answer] of [
    ["declines", () => ({ action: "decline" })],
    ["cancels", () => ({ action: "cancel" })],
    ["accepts with confirm false", () => ({ action: "accept", content: { confirm: false } })],
    [
      "answers with an error",
      () => {
        throw new Error("the client failed");
      },
    ],
  ] as const) {
    test(`the user ${label}: CLI_CONFIRM_REQUIRED, and no spend request is sent`, async () => {
      const session = await start({
        allowWrites: true,
        allowSpend: true,
        elicitation: answer as ElicitationAnswer,
      });
      const result = await session.client.callTool({
        name: "compute_upgrade_server",
        arguments: UPGRADE,
      });
      expect(result.isError).toBe(true);
      expect(resultJson(result)).toMatchObject({ error: { code: "CLI_CONFIRM_REQUIRED" } });
      expect(spends()).toEqual([]);
    });
  }

  test("a wrong expectedAmount is CLI_INVALID_INPUT that names the quote, with no question and no spend", async () => {
    const session = await start({ allowWrites: true, allowSpend: true, elicitation: accept });
    const result = await session.client.callTool({
      name: "compute_upgrade_server",
      arguments: { ...UPGRADE, expectedAmount: "10.000" },
    });
    expect(result.isError).toBe(true);
    const error = (resultJson(result) as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.message).toContain('"100.000"');
    expect(session.elicitations).toEqual([]);
    expect(spends()).toEqual([]);
  });

  test("the same amount written with fewer decimals passes", async () => {
    const session = await start({ allowWrites: true, allowSpend: true, elicitation: accept });
    const result = await session.client.callTool({
      name: "compute_upgrade_server",
      arguments: { ...UPGRADE, expectedAmount: "100" },
    });
    expect(result.isError).toBeUndefined();
    expect(spends()[0]?.body).toMatchObject({ expectedAmount: "100" });
  });

  test("a quote the API cannot find passes its error on, with no question and no spend", async () => {
    state.storedQuote = null;
    const session = await start({ allowWrites: true, allowSpend: true, elicitation: accept });
    const result = await session.client.callTool({
      name: "compute_upgrade_server",
      arguments: UPGRADE,
    });
    expect(result.isError).toBe(true);
    expect(resultJson(result)).toMatchObject({ error: { status: 404, code: "QUOTE_NOT_FOUND" } });
    expect(session.elicitations).toEqual([]);
    expect(spends()).toEqual([]);
  });

  test("the question uses the API's figures, not the model's", async () => {
    state.storedQuote = upgradeQuote({ accountBalance: "12.300", sufficient: false });
    const session = await start({ allowWrites: true, allowSpend: true, elicitation: accept });
    await session.client.callTool({ name: "compute_upgrade_server", arguments: UPGRADE });
    expect(session.elicitations[0]).toContain("account balance: NT$12.3");
    expect(session.elicitations[0]).toContain("the account balance is short of this amount");
  });

  test("a quote tool call asks nothing", async () => {
    const session = await start({ allowWrites: true, allowSpend: true, elicitation: accept });
    await session.client.callTool({
      name: "compute_quote_upgrade_server",
      arguments: { serverId: "srv-1", planSlug: "s2" },
    });
    expect(session.elicitations).toEqual([]);
    expect(sentRoutes(api)).toEqual(["POST /v1/servers/srv-1/upgrade/quote"]);
  });

  test("no tool result shows the token", async () => {
    const session = await start({ allowWrites: true, allowSpend: true, elicitation: accept });
    const result = await session.client.callTool({
      name: "compute_upgrade_server",
      arguments: UPGRADE,
    });
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
    expect(session.elicitations.join("\n")).not.toContain(FAKE_TOKEN);
  });
});
