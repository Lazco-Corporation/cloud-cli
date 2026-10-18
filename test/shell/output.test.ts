import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import packageJson from "../../package.json" with { type: "json" };
import { cliEnv, FAKE_TOKEN, makeHome, ndjson, runLazco, runLazcoOnTerminal } from "../helpers/cli";
import type { FakeApi } from "../helpers/fakeApi";
import { closedApiUrl } from "../helpers/fakeApi";
import { fixtureApi } from "../helpers/fixtureApi";

const ESC = "\u001b";

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

function env(extra: Record<string, string | undefined> = {}) {
  return cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN, ...extra });
}

describe("stdout", () => {
  test("--version prints the bare version", async () => {
    const run = await runLazco(["--version"], env());
    expect(run).toEqual({ code: 0, stdout: `${packageJson.version}\n`, stderr: "" });
  });

  test("one record is one JSON object, with no ANSI byte even when the API sends one", async () => {
    const run = await runLazco(["--api-url", api.apiUrl, "compute", "get", "srv-1"], env());
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain(ESC);
    expect(JSON.parse(run.stdout)).toEqual({
      id: "srv-1",
      hostname: "web-1\u001b[31m",
      status: "running",
      ipv4: "192.0.2.10",
    });
    expect(run.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("a list is NDJSON, and the next page is named on stderr", async () => {
    const run = await runLazco(["--api-url", api.apiUrl, "compute", "list"], env());
    expect(run.code).toBe(0);
    expect(ndjson(run.stdout)).toEqual([
      { id: "srv-1", hostname: "web-1", region: "txg1" },
      { id: "srv-2", hostname: "web-2", region: "txg1" },
    ]);
    expect(run.stderr).toContain("--cursor c-2");
  });

  test("a JSON array answer is a list too", async () => {
    const run = await runLazco(["--api-url", api.apiUrl, "regions", "list"], env());
    expect(ndjson(run.stdout)).toEqual([{ slug: "txg1" }, { slug: "tpe1" }]);
  });

  test("--page-all prints every item and stops at a null cursor", async () => {
    const run = await runLazco(["--api-url", api.apiUrl, "compute", "list", "--page-all"], env());
    expect(ndjson(run.stdout).map((item) => (item as { id: string }).id)).toEqual([
      "srv-1",
      "srv-2",
      "srv-3",
    ]);
    expect(run.stderr).toContain("page 2");
  });

  test("NDJSON on a pseudo-terminal is exactly NDJSON in a pipe", async () => {
    const piped = await runLazco(["--api-url", api.apiUrl, "compute", "list", "--page-all"], env());
    const terminal = await runLazcoOnTerminal(
      ["--api-url", api.apiUrl, "compute", "list", "--page-all"],
      env(),
    );
    expect(terminal.code).toBe(0);
    const terminalLines = terminal.output.split("\n").filter((line) => line.startsWith("{"));
    expect(terminalLines.join("\n")).toBe(piped.stdout.trim());
    expect(terminal.output).not.toContain(ESC);
  });

  test("--fields keeps the named fields, in order, and ignores a name no record has", async () => {
    const run = await runLazco(
      ["--api-url", api.apiUrl, "compute", "list", "--fields", "hostname,id,nothing"],
      env(),
    );
    expect(run.stdout.split("\n")[0]).toBe('{"hostname":"web-1","id":"srv-1"}');
  });

  test("--help prints usage text", async () => {
    const run = await runLazco(
      ["--api-url", api.apiUrl, "compute", "get", "--help"],
      env({ NO_COLOR: "1" }),
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("USAGE lazco compute get");
    expect(run.stdout).toContain("SERVERID");
  });

  test("a bare lazco prints usage with the first command words", async () => {
    const run = await runLazco(["--api-url", api.apiUrl], env({ NO_COLOR: "1" }));
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("compute");
    expect(run.stdout).toContain("--page-all");
  });
});

describe("--human", () => {
  test("a list is a table and a record is key: value lines", async () => {
    const list = await runLazco(
      ["--api-url", api.apiUrl, "compute", "list", "--human"],
      env({ NO_COLOR: "1" }),
    );
    expect(list.stdout.split("\n").slice(0, 3)).toEqual([
      "ID     HOSTNAME  REGION",
      "srv-1  web-1     txg1",
      "srv-2  web-2     txg1",
    ]);
    const record = await runLazco(
      ["--api-url", api.apiUrl, "compute", "get", "srv-1", "--human"],
      env({ NO_COLOR: "1" }),
    );
    expect(record.stdout).toBe(
      "id:       srv-1\nhostname: web-1\\u001b[31m\nstatus:   running\nipv4:     192.0.2.10\n",
    );
  });

  test("an error is one colored line on a terminal, and plain with NO_COLOR", async () => {
    const colored = await runLazcoOnTerminal(
      ["--api-url", api.apiUrl, "compute", "get", "srv-x", "--human"],
      env(),
    );
    expect(colored.code).toBe(1);
    expect(colored.output).toContain(`${ESC}[31merror NOT_FOUND (404): Not found`);
    const plain = await runLazcoOnTerminal(
      ["--api-url", api.apiUrl, "compute", "get", "srv-x", "--human"],
      env({ NO_COLOR: "1" }),
    );
    expect(plain.output).not.toContain(ESC);
    expect(plain.output).toContain("error NOT_FOUND (404): Not found");
  });
});

describe("errors", () => {
  test("a 404 passes through on stderr with an empty stdout and exit code 1", async () => {
    const run = await runLazco(["--api-url", api.apiUrl, "compute", "get", "srv-x"], env());
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(JSON.parse(run.stderr)).toEqual({
      error: {
        status: 404,
        code: "NOT_FOUND",
        message: "Not found",
        timestamp: "2026-10-18T00:00:00Z",
      },
    });
  });

  const cases: Array<
    [string, () => Promise<{ args: string[]; extra?: Record<string, string | undefined> }>, string]
  > = [
    [
      "an unknown flag",
      async () => ({
        args: ["--api-url", api.apiUrl, "compute", "get", "srv-1", "--colour", "red"],
      }),
      "CLI_INVALID_INPUT",
    ],
    [
      "an unknown command",
      async () => ({ args: ["--api-url", api.apiUrl, "nothing", "here"] }),
      "CLI_INVALID_INPUT",
    ],
    [
      "a group without a command",
      async () => ({ args: ["--api-url", api.apiUrl, "compute"] }),
      "CLI_INVALID_INPUT",
    ],
    [
      "a guard refusal",
      async () => ({ args: ["--api-url", api.apiUrl, "compute", "get", "../admin"] }),
      "CLI_INVALID_INPUT",
    ],
    [
      "no credential",
      async () => ({
        args: ["--api-url", api.apiUrl, "compute", "get", "srv-1"],
        extra: { LAZCO_TOKEN: undefined },
      }),
      "CLI_NOT_LOGGED_IN",
    ],
    [
      "no spec",
      async () => ({ args: ["--api-url", await closedApiUrl(), "compute", "list"] }),
      "CLI_SPEC_UNAVAILABLE",
    ],
    [
      "a bad --timeout",
      async () => ({ args: ["--api-url", api.apiUrl, "--timeout", "soon", "compute", "list"] }),
      "CLI_INVALID_INPUT",
    ],
    [
      "--page-all on a record",
      async () => ({ args: ["--api-url", api.apiUrl, "compute", "get", "srv-1", "--page-all"] }),
      "CLI_INVALID_INPUT",
    ],
  ];
  for (const [label, makeCase, code] of cases) {
    test(`${label} is ${code}, exit code 1 and an empty stdout`, async () => {
      const { args, extra } = await makeCase();
      const run = await runLazco(args, env(extra));
      expect(run.code).toBe(1);
      expect(run.stdout).toBe("");
      const lines = run.stderr.trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1] as string);
      expect(last.error.code).toBe(code);
      expect(last.error.status).toBeUndefined();
    });
  }

  test("a failure in the middle of --page-all prints nothing on stdout", async () => {
    const handler = api.handler;
    api.handler = (request) =>
      request.search.includes("cursor=c-2")
        ? new Response("<html>502</html>", {
            status: 502,
            headers: { "content-type": "text/html" },
          })
        : handler(request);
    const run = await runLazco(["--api-url", api.apiUrl, "compute", "list", "--page-all"], env());
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("CLI_BAD_RESPONSE");
  });
});
