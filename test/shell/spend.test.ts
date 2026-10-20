import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import packageJson from "../../package.json" with { type: "json" };
import { cliEnv, FAKE_TOKEN, makeHome, runInProcess, runLazcoOnTerminal } from "../helpers/cli";
import { type FakeApi, fakeClock, json } from "../helpers/fakeApi";
import { loadFixture } from "../helpers/fixtures";
import { quoteBody } from "../helpers/quotes";
import { type SpendState, sentRoutes, spendApi, upgradeQuote } from "../helpers/spendApi";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UPGRADE = ["compute", "upgrade", "srv-1", "--plan-slug", "s2"];

let state: SpendState;
let api: FakeApi;
let home: Awaited<ReturnType<typeof makeHome>>;

beforeEach(async () => {
  state = { quote: upgradeQuote() };
  api = spendApi(state);
  home = await makeHome();
});

afterEach(async () => {
  api.stop();
  await home.cleanup();
});

const env = () => cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN, NO_COLOR: "1" });
const run = (args: readonly string[]) =>
  runInProcess(["--api-url", api.apiUrl, ...args], { env: env(), clock: fakeClock() });

function lastError(stderr: string) {
  return JSON.parse(stderr.trim().split("\n").at(-1) as string).error;
}

function spendRequests() {
  return api.requests.filter(
    (request) => request.path === "/v1/servers/srv-1/upgrade" && request.method === "POST",
  );
}

describe("a spend command quotes, asks, and then spends", () => {
  test("on a terminal, a yes sends the spend with the quote, the amount unchanged and a key", async () => {
    const result = await runLazcoOnTerminal(["--api-url", api.apiUrl, ...UPGRADE], env(), [
      { after: "[y/N]", type: "y" },
    ]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("quote q-up: NT$100 from the account balance");
    expect(result.output).toContain("Spend NT$100 from the account balance? [y/N]");
    expect(sentRoutes(api)).toEqual([
      "POST /v1/servers/srv-1/upgrade/quote",
      "POST /v1/servers/srv-1/upgrade",
    ]);
    const [quote, spend] = api.requests.filter((request) => request.path.includes("upgrade"));
    expect(quote?.body).toEqual({ planSlug: "s2" });
    expect(quote?.headers["idempotency-key"]).toBeUndefined();
    expect(spend?.body).toEqual({ planSlug: "s2", quoteId: "q-up", expectedAmount: "100.000" });
    expect(spend?.headers["idempotency-key"]).toMatch(UUID_V4);
    expect(result.output).toContain('{"spent":"compute.servers.upgrade"}');
  });

  test("on a terminal, a no sends no spend and exits with CLI_CONFIRM_REQUIRED", async () => {
    const result = await runLazcoOnTerminal(["--api-url", api.apiUrl, ...UPGRADE], env(), [
      { after: "[y/N]", type: "n" },
    ]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("CLI_CONFIRM_REQUIRED");
    expect(sentRoutes(api)).toEqual(["POST /v1/servers/srv-1/upgrade/quote"]);
  });

  test("on a terminal, an empty answer is a no", async () => {
    const result = await runLazcoOnTerminal(["--api-url", api.apiUrl, ...UPGRADE], env(), [
      { after: "[y/N]", type: "" },
    ]);
    expect(result.code).toBe(1);
    expect(spendRequests()).toEqual([]);
  });

  test("a script without --yes gets the quote in details.quote and spends nothing", async () => {
    const result = await run(UPGRADE);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const error = lastError(result.stderr);
    expect(error.code).toBe("CLI_CONFIRM_REQUIRED");
    expect(error.details.quote).toEqual(upgradeQuote());
    expect(sentRoutes(api)).toEqual(["POST /v1/servers/srv-1/upgrade/quote"]);
  });

  test("a script with --yes shows the quote on stderr and prints only the result on stdout", async () => {
    const result = await run([...UPGRADE, "--yes"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ spent: "compute.servers.upgrade" });
    expect(result.stderr.split("\n").filter(Boolean)).toEqual([
      "lazco: quote q-up: NT$100 from the account balance",
      "lazco:   Plan s1 to s2, 12 days: NT$100 (2026-10-20T00:00:00.000Z to 2026-11-01T00:00:00.000Z)",
      "lazco: period: 2026-10-20T00:00:00.000Z to 2026-11-01T00:00:00.000Z",
      "lazco: then NT$250 every 30 days, from 2026-11-01T00:00:00.000Z",
      "lazco: account balance: NT$1000",
      "lazco: the quote expires at 2026-10-20T00:10:00.000Z, and is good for one spend",
    ]);
    expect(spendRequests()[0]?.body).toMatchObject({ quoteId: "q-up", expectedAmount: "100.000" });
  });

  test("a short account balance is said before the question, and the answer still defaults to no", async () => {
    state.quote = upgradeQuote({ sufficient: false, accountBalance: "20.500" });
    const result = await runLazcoOnTerminal(["--api-url", api.apiUrl, ...UPGRADE], env(), [
      { after: "[y/N]", type: "" },
    ]);
    expect(result.code).toBe(1);
    const short = result.output.indexOf("the account balance is short of this amount");
    expect(short).toBeGreaterThan(-1);
    expect(short).toBeLessThan(result.output.indexOf("[y/N]"));
    expect(result.output).toContain("account balance: NT$20.5");
    expect(spendRequests()).toEqual([]);
  });

  test("no line of stderr or stdout shows the token, even when the API echoes it", async () => {
    state.quote = upgradeQuote({
      lines: [
        { code: "plan", description: `Bearer ${FAKE_TOKEN}`, amount: "100.000", period: null },
      ],
    });
    const asked = await run(UPGRADE);
    expect(asked.stderr).toContain("Bearer [REDACTED]");
    const dry = await run([...UPGRADE, "--dry-run"]);
    expect(dry.stdout).toContain("Bearer [REDACTED]");
    const spent = await run([...UPGRADE, "--yes"]);
    for (const output of [asked, dry, spent]) {
      expect(output.stdout + output.stderr).not.toContain(FAKE_TOKEN);
    }
  });

  test("money stays the string the API sent, never a float", async () => {
    state.quote = upgradeQuote({ amount: "5.000" });
    const result = await run([...UPGRADE, "--yes"]);
    expect(result.code).toBe(0);
    expect(spendRequests()[0]?.body).toMatchObject({ expectedAmount: "5.000" });
    expect(result.stderr).toContain("NT$5 from the account balance");
  });

  test("a spend with no body input of its own sends the quote with no body", async () => {
    state.quote = quoteBody({
      quoteId: "q-pack",
      operationId: "labs.pages.packs.create",
      amount: "52.500",
    });
    const result = await run(["labs", "pages", "packs", "create", "--yes"]);
    expect(result.code).toBe(0);
    const [quote, spend] = api.requests.filter((request) => request.path.includes("/packs"));
    expect(quote?.path).toBe("/v1/labs/pages/packs/quote");
    expect(quote?.body).toBeUndefined();
    expect(spend?.body).toEqual({ quoteId: "q-pack", expectedAmount: "52.500" });
  });

  test("a spend by DELETE sends its quote by POST and its spend with the body", async () => {
    state.quote = quoteBody({
      quoteId: "q-resume",
      operationId: "compute.renewal.resume",
      amount: "0.000",
    });
    const result = await run(["compute", "renewal", "resume", "srv-1", "--yes"]);
    expect(result.code).toBe(0);
    expect(sentRoutes(api)).toEqual([
      "POST /v1/servers/srv-1/cancel-renewal/quote",
      "DELETE /v1/servers/srv-1/cancel-renewal",
    ]);
    expect(api.requests.at(-1)?.body).toEqual({ quoteId: "q-resume", expectedAmount: "0.000" });
  });

  test("a failed quote request spends nothing and never says the spend may have run", async () => {
    state.quoteAnswer = () => new Response("<html>502</html>", { status: 502 });
    const result = await run([...UPGRADE, "--yes"]);
    expect(result.code).toBe(1);
    expect(lastError(result.stderr).code).toBe("CLI_BAD_RESPONSE");
    expect(result.stderr).not.toContain("may have run");
    expect(spendRequests()).toEqual([]);
    // A quote is no keyed request, so it is never sent again.
    expect(sentRoutes(api)).toEqual(["POST /v1/servers/srv-1/upgrade/quote"]);
  });

  test("a quote amount the spend cannot send back is CLI_BAD_RESPONSE before any question", async () => {
    state.quote = upgradeQuote({ amount: "100.5555" });
    const result = await runLazcoOnTerminal(["--api-url", api.apiUrl, ...UPGRADE], env());
    expect(result.code).toBe(1);
    expect(result.output).toContain("CLI_BAD_RESPONSE");
    expect(result.output).not.toContain("[y/N]");
    expect(spendRequests()).toEqual([]);
  });

  test("a quote without the optional figures shows no undefined", async () => {
    state.quote = { quoteId: "q-min", operationId: "compute.servers.upgrade", amount: "1.000" };
    const result = await run([...UPGRADE, "--yes"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("quote q-min: NT$1 from the account balance");
    expect(result.stderr).not.toContain("undefined");
    expect(result.stderr).not.toContain("null");
  });

  test("an open quote schema gets the whole input, so it prices what the spend sends", async () => {
    const spec = loadFixture("spend");
    for (const path of ["/v1/servers/{serverId}/upgrade", "/v1/servers/{serverId}/upgrade/quote"]) {
      const schema = spec.paths[path]?.post?.requestBody?.content?.["application/json"]?.schema;
      if (!schema) throw new Error("fixture changed");
      schema.additionalProperties = true;
    }
    state.spec = spec;
    const result = await run([...UPGRADE, "--yes", "--json", '{"note":"priced too"}']);
    expect(result.code).toBe(0);
    const [quote, spend] = api.requests.filter((request) => request.path.includes("upgrade"));
    expect(quote?.body).toEqual({ planSlug: "s2", note: "priced too" });
    expect(spend?.body).toEqual({
      planSlug: "s2",
      note: "priced too",
      quoteId: "q-up",
      expectedAmount: "100.000",
    });
  });

  test("a spend with no final answer names the key and the quote to get its result", async () => {
    state.spendAnswer = () => new Response("<html>502</html>", { status: 502 });
    const result = await run([...UPGRADE, "--yes"]);
    expect(result.code).toBe(1);
    const key = spendRequests()[0]?.headers["idempotency-key"] as string;
    expect(spendRequests().every((request) => request.headers["idempotency-key"] === key)).toBe(
      true,
    );
    expect(result.stderr).toContain(
      `run the same command with --idempotency-key ${key} --quote-id q-up --expected-amount 100.000`,
    );
  });

  test("a quote answer without a quote id is CLI_BAD_RESPONSE and spends nothing", async () => {
    state.quote = { amount: "100.000" };
    const result = await run([...UPGRADE, "--yes"]);
    expect(result.code).toBe(1);
    expect(lastError(result.stderr).code).toBe("CLI_BAD_RESPONSE");
    expect(spendRequests()).toEqual([]);
  });

  test("an input the spend refuses fails before the quote is asked", async () => {
    const result = await run(["compute", "upgrade", "srv-1", "--yes"]);
    expect(result.code).toBe(1);
    expect(lastError(result.stderr)).toMatchObject({
      code: "CLI_INVALID_INPUT",
      details: [{ field: "planSlug", message: "is required" }],
    });
    expect(sentRoutes(api)).toEqual([]);
  });

  for (const field of ["quoteId", "expectedAmount"]) {
    test(`${field} in --json is refused as no input of the command, before any request`, async () => {
      const result = await run([...UPGRADE, "--yes", "--json", JSON.stringify({ [field]: "1" })]);
      expect(result.code).toBe(1);
      const error = lastError(result.stderr);
      expect(error.code).toBe("CLI_INVALID_INPUT");
      expect(error.details).toEqual([{ field, message: expect.any(String) }]);
      expect(sentRoutes(api)).toEqual([]);
    });
  }
});

describe("--dry-run of a spend command", () => {
  test("sends only the quote request, and prints the spend it would send with the quote", async () => {
    const result = await run([...UPGRADE, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(sentRoutes(api)).toEqual(["POST /v1/servers/srv-1/upgrade/quote"]);
    const preview = JSON.parse(result.stdout);
    expect(preview).toEqual({
      dryRun: true,
      method: "POST",
      url: `${api.apiUrl}/servers/srv-1/upgrade`,
      headers: {
        Accept: "application/json",
        "User-Agent": `lazco-cli/${packageJson.version}`,
        "Content-Type": "application/json",
        "Idempotency-Key": expect.stringMatching(UUID_V4),
      },
      body: { planSlug: "s2", quoteId: "q-up", expectedAmount: "100.000" },
      quote: upgradeQuote(),
    });
    expect(JSON.stringify(preview)).not.toContain(FAKE_TOKEN);
  });

  test("asks nothing on a terminal and needs no --yes", async () => {
    const result = await runLazcoOnTerminal(
      ["--api-url", api.apiUrl, ...UPGRADE, "--dry-run"],
      env(),
    );
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("[y/N]");
    expect(spendRequests()).toEqual([]);
  });

  test("with --quote-id and --expected-amount it sends nothing at all", async () => {
    const result = await run([
      ...UPGRADE,
      "--dry-run",
      "--quote-id",
      "q-old",
      "--expected-amount",
      "100.5",
    ]);
    expect(result.code).toBe(0);
    expect(sentRoutes(api)).toEqual([]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      body: { planSlug: "s2", quoteId: "q-old", expectedAmount: "100.5" },
      quote: null,
    });
  });
});

describe("--quote-id and --expected-amount", () => {
  test("send the spend with that quote and ask for no new one", async () => {
    const result = await run([
      ...UPGRADE,
      "--yes",
      "--quote-id",
      "q-dry",
      "--expected-amount=100.000",
    ]);
    expect(result.code).toBe(0);
    expect(sentRoutes(api)).toEqual(["POST /v1/servers/srv-1/upgrade"]);
    expect(spendRequests()[0]?.body).toEqual({
      planSlug: "s2",
      quoteId: "q-dry",
      expectedAmount: "100.000",
    });
    expect(result.stderr).toContain("quote q-dry: NT$100 from the account balance");
  });

  test("still need --yes without a terminal, and the error names the given quote", async () => {
    const result = await run([...UPGRADE, "--quote-id", "q-dry", "--expected-amount", "100"]);
    expect(result.code).toBe(1);
    expect(lastError(result.stderr)).toMatchObject({
      code: "CLI_CONFIRM_REQUIRED",
      details: { quote: { quoteId: "q-dry", amount: "100" } },
    });
    expect(sentRoutes(api)).toEqual([]);
  });

  for (const [label, flags, field] of [
    ["--quote-id alone", ["--quote-id", "q-1"], "expected-amount"],
    ["--expected-amount alone", ["--expected-amount", "100"], "quote-id"],
    [
      "an amount with 4 decimals",
      ["--quote-id", "q-1", "--expected-amount", "1.2345"],
      "expected-amount",
    ],
    ["a negative amount", ["--quote-id", "q-1", "--expected-amount=-5"], "expected-amount"],
    [
      "an amount that is no number",
      ["--quote-id", "q-1", "--expected-amount", "1e3"],
      "expected-amount",
    ],
  ] as const) {
    test(`${label} is CLI_INVALID_INPUT before any request`, async () => {
      const result = await run([...UPGRADE, "--yes", ...flags]);
      expect(result.code).toBe(1);
      const error = lastError(result.stderr);
      expect(error.code).toBe("CLI_INVALID_INPUT");
      expect(error.details[0].field).toBe(field);
      expect(sentRoutes(api)).toEqual([]);
    });
  }

  test("--help of a spend command lists --yes, --idempotency-key, --quote-id and --expected-amount", async () => {
    const result = await run(["compute", "create", "--help"]);
    expect(result.code).toBe(0);
    for (const flag of ["--yes", "--idempotency-key", "--quote-id", "--expected-amount"]) {
      expect(result.stdout).toContain(flag);
    }
    const quote = await run(["compute", "quote-create", "--help"]);
    expect(quote.stdout).not.toContain("--quote-id");
  });
});

describe("a refused quote is never retried with a new one", () => {
  for (const code of [
    "QUOTE_EXPIRED",
    "QUOTE_ALREADY_USED",
    "QUOTE_PRICE_CHANGED",
    "QUOTE_AMOUNT_MISMATCH",
  ]) {
    test(`${code} passes through, exits 1, and sends nothing more`, async () => {
      state.spendAnswer = () =>
        json(409, { error: "Conflict", code, quoteId: "q-up", amount: "100.000" });
      const result = await run([...UPGRADE, "--yes"]);
      expect(result.code).toBe(1);
      expect(lastError(result.stderr)).toMatchObject({
        status: 409,
        code,
        quoteId: "q-up",
        amount: "100.000",
      });
      expect(sentRoutes(api)).toEqual([
        "POST /v1/servers/srv-1/upgrade/quote",
        "POST /v1/servers/srv-1/upgrade",
      ]);
      expect(result.stderr).not.toContain("may have run");
    });
  }

  test("an expired quote given by a script is passed through, with no new quote", async () => {
    state.spendAnswer = () =>
      json(409, { error: "Conflict", code: "QUOTE_EXPIRED", quoteId: "q-old" });
    const result = await run([
      ...UPGRADE,
      "--yes",
      "--quote-id",
      "q-old",
      "--expected-amount",
      "100.000",
    ]);
    expect(result.code).toBe(1);
    expect(lastError(result.stderr).code).toBe("QUOTE_EXPIRED");
    expect(sentRoutes(api)).toEqual(["POST /v1/servers/srv-1/upgrade"]);
  });
});
