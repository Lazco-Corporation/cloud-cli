import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DATA_SENTENCE } from "../../src/mcp/tools";
import { VERSION } from "../../src/shell/run";
import { CLI_PATH, cliEnv, FAKE_TOKEN, makeHome } from "../helpers/cli";
import { type FakeApi, json } from "../helpers/fakeApi";
import { type FixtureState, fixtureApi } from "../helpers/fixtureApi";
import { resultJson } from "../helpers/mcp";

let api: FakeApi;
let state: FixtureState;
let home: Awaited<ReturnType<typeof makeHome>>;
let client: Client | undefined;

beforeEach(async () => {
  state = {};
  api = fixtureApi(state);
  home = await makeHome();
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  api.stop();
  await home.cleanup();
});

/** Starts `lazco mcp` as an MCP client does, and connects the SDK's client over stdio. */
async function connect(
  args: readonly string[] = [],
): Promise<{ client: Client; stderr: string[] }> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [CLI_PATH, "--api-url", api.apiUrl, "mcp", ...args],
    env: cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN }),
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  client = new Client({ name: "test-client", version: "1.2.3" });
  await client.connect(transport);
  return { client, stderr };
}

describe("lazco mcp on stdio", () => {
  test("without a sign-in it exits with 1, CLI_NOT_LOGGED_IN on stderr and nothing on stdout", async () => {
    const child = Bun.spawn(["bun", CLI_PATH, "--api-url", api.apiUrl, "mcp"], {
      env: cliEnv(home.home),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr).error.code).toBe("CLI_NOT_LOGGED_IN");
    expect(api.requests).toEqual([]);
  });

  test("no byte reaches stdout before initialize, and the startup reads come first", async () => {
    const child = Bun.spawn(["bun", CLI_PATH, "--api-url", api.apiUrl, "mcp"], {
      env: cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    let stdout = "";
    const reading = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        stdout += new TextDecoder().decode(value);
      }
    })();
    for (let waited = 0; api.requests.length < 2 && waited < 10_000; waited += 50) {
      await Bun.sleep(50);
    }
    await Bun.sleep(500);
    expect(api.requests.map((request) => request.path).sort()).toEqual(["/v1/spec", "/v1/whoami"]);
    expect(stdout).toBe("");

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "raw", version: "1" },
        },
      })}\n`,
    );
    for (let waited = 0; !stdout.includes("\n") && waited < 10_000; waited += 50) {
      await Bun.sleep(50);
    }
    const answer = JSON.parse(stdout.split("\n")[0] as string);
    expect(answer.id).toBe(1);
    expect(answer.result.capabilities).toEqual({ tools: { listChanged: true } });
    child.stdin.end();
    expect(await child.exited).toBe(0);
    await reading;
  });

  /** Runs `lazco mcp` with arguments to its end, with stdin left open as a client leaves it. */
  async function runToExit(args: readonly string[]) {
    const child = Bun.spawn(["bun", CLI_PATH, "--api-url", api.apiUrl, "mcp", ...args], {
      env: cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  }

  test("an --only prefix that matches no command exits with 1 and CLI_INVALID_INPUT before any MCP message", async () => {
    const run = await runToExit(["--only", "labs artefacts"]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    const error = JSON.parse(run.stderr.trim().split("\n").at(-1) as string).error;
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.message).toContain('"labs artefacts"');
  });

  test("an empty --only exits with 1 and CLI_INVALID_INPUT before any request", async () => {
    const run = await runToExit(["--only", " "]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(JSON.parse(run.stderr.trim().split("\n").at(-1) as string).error.code).toBe(
      "CLI_INVALID_INPUT",
    );
    expect(api.requests).toEqual([]);
  });

  test("--only on stdio limits the tools and the instructions name the prefix", async () => {
    const { client } = await connect(["--only", "compute"]);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["compute_get_server", "compute_list_servers"]);
    expect(client.getInstructions()).toContain(
      "This session offers only the tools under: compute.",
    );
  });

  test("the capabilities are tools with listChanged, and no resources or prompts", async () => {
    const { client } = await connect();
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools).toEqual({ listChanged: true });
    expect(capabilities?.resources).toBeUndefined();
    expect(capabilities?.prompts).toBeUndefined();
    expect(client.getServerVersion()?.name).toBe("lazco");
  });

  test("the instructions hold the organization, the write state, the hidden features and the data sentence", async () => {
    state.features = { dns: false };
    const { client } = await connect();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("Fixture Org");
    expect(instructions).toContain("org-1");
    expect(instructions).toContain("read only");
    expect(instructions).toContain("--allow-writes");
    expect(instructions).toContain("dns");
    expect(instructions).toContain(DATA_SENTENCE);
  });

  test("with --allow-writes the instructions say the session can write", async () => {
    const { client } = await connect(["--allow-writes"]);
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("This session can write");
    expect(instructions).not.toContain("read only");
  });

  test("--allow-spend is a flag of lazco mcp, and the instructions say whether spend tools are offered", async () => {
    const { client } = await connect(["--allow-writes", "--allow-spend"]);
    // The surface fixture's one spend operation has mcp false, so no spend tool comes of it.
    expect(client.getInstructions()).toContain(
      "No spend tool is offered, because no spend operation of the spec has a tool and a quote tool",
    );
  });

  test("without --allow-spend the instructions say how to add the spend tools", async () => {
    const { client } = await connect(["--allow-writes"]);
    expect(client.getInstructions()).toContain(
      "No spend tool is offered, because it was started without --allow-spend",
    );
  });

  test("the User-Agent names mcp at startup and the client after initialize", async () => {
    const { client } = await connect();
    const startup = api.requests.map((request) => request.headers["user-agent"]);
    expect(startup).toEqual([`lazco-cli/${VERSION} (mcp)`, `lazco-cli/${VERSION} (mcp)`]);
    const result = await client.callTool({
      name: "compute_get_server",
      arguments: { serverId: "srv-1" },
    });
    expect(result.isError).toBeUndefined();
    expect(api.requests.at(-1)?.headers["user-agent"]).toBe(
      `lazco-cli/${VERSION} (mcp; test-client/1.2.3)`,
    );
  });

  test("a tool result never holds the token, even when the API echoes it", async () => {
    const handler = api.handler;
    api.handler = (request) =>
      request.path === "/v1/servers/echo"
        ? json(200, { id: "echo", seen: request.headers.authorization })
        : handler(request);
    const { client } = await connect();
    const result = await client.callTool({
      name: "compute_get_server",
      arguments: { serverId: "echo" },
    });
    expect(resultJson(result)).toEqual({ id: "echo", seen: "Bearer [REDACTED]" });
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN.slice(-8));
  });
});
