import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  API_URL,
  errorOf,
  lazco,
  READ_TOKEN,
  type Run,
  stagingFeatures,
  stagingOperations,
  temporaryHome,
  WRITE_TOKEN,
} from "./staging";

const TIMEOUT_MS = 120_000;
const PACK_CREATE = ["labs", "pages", "packs", "create"];
/** No server has this id, and staging has no server to buy an add-on for. */
const MISSING_SERVER = "00000000-0000-4000-8000-000000000000";

/**
 * A pack costs the organization a month of it each run, with no refund on
 * delete, so the purchase runs only when asked: CI asks on a push to `main`.
 */
const SPEND_ALLOWED = process.env.LAZCO_CONTRACT_SPEND === "1";

const operations = await stagingOperations();
const features = await stagingFeatures(READ_TOKEN);
let home: Awaited<ReturnType<typeof temporaryHome>>;

type Pack = { id: string; status: string };
type Quote = { quoteId: string; operationId: string; status: string; amount: string };
/** The pack statuses that still renew, so a delete is due. */
const RENEWING: ReadonlySet<string> = new Set(["active", "renewal_grace", "suspended"]);

beforeAll(async () => {
  home = await temporaryHome();
});

afterAll(async () => {
  // A pack left by a spending test that timed out is deleted here too, before it renews.
  try {
    if (SPEND_ALLOWED) {
      await deleteLivePacks();
    }
  } finally {
    await home.cleanup();
  }
}, TIMEOUT_MS);

function succeeded(run: Run): { code: number; stderr: string } {
  return { code: run.code, stderr: run.stderr };
}

async function packs(): Promise<Pack[]> {
  const run = await lazco(home.home, READ_TOKEN, ["labs", "pages", "entitlement", "get"]);
  expect(succeeded(run)).toEqual({ code: 0, stderr: "" });
  return (JSON.parse(run.stdout) as { packs?: Pack[] }).packs ?? [];
}

/** The account balance in TWD, as `billing balance get` answers it. */
async function balance(): Promise<number> {
  const run = await lazco(home.home, READ_TOKEN, ["billing", "balance", "get"]);
  expect(succeeded(run)).toEqual({ code: 0, stderr: "" });
  return Number((JSON.parse(run.stdout) as { balanceAmount: number | string }).balanceAmount);
}

async function storedQuote(quoteId: string): Promise<Quote> {
  const run = await lazco(home.home, READ_TOKEN, ["billing", "quotes", "get", quoteId]);
  expect(succeeded(run)).toEqual({ code: 0, stderr: "" });
  return JSON.parse(run.stdout) as Quote;
}

/**
 * Deletes every pack that still renews. Only the spending test buys packs in
 * the contract organization, so one left by a run that stopped early is
 * deleted here, before it renews.
 */
async function deleteLivePacks(): Promise<void> {
  for (const pack of await packs()) {
    if (RENEWING.has(pack.status)) {
      const deleted = await lazco(home.home, WRITE_TOKEN, [
        "labs",
        "pages",
        "packs",
        "delete",
        pack.id,
        "--yes",
      ]);
      expect(succeeded(deleted)).toEqual({ code: 0, stderr: "" });
    }
  }
}

describe("Idempotency-Key", () => {
  test("the staging spec requires the key on every spend operation", () => {
    const spend = operations.filter((operation) => operation.kind === "spend");
    expect(spend.length).toBeGreaterThan(0);
    expect(
      spend
        .filter((operation) => operation.idempotencyKey !== "required")
        .map((operation) => operation.command.join(" ")),
    ).toEqual([]);
  });
});

describe("spend quotes", () => {
  test("the staging spec gives every spend command a quote operation", () => {
    const spend = operations.filter((operation) => operation.kind === "spend");
    expect(
      spend
        .filter((operation) => operation.quote === null)
        .map((operation) => operation.command.join(" ")),
    ).toEqual([]);
    expect(spend.map((operation) => operation.command.join(" "))).toContain(
      "compute bandwidth-addons buy",
    );
  });

  test(
    "a --dry-run of a spend sends only the quote request: the quote stays open and nothing is charged",
    async () => {
      expect(features.pages).toBe(true);
      const balanceBefore = await balance();
      const packsBefore = await packs();

      const run = await lazco(home.home, WRITE_TOKEN, [...PACK_CREATE, "--dry-run"]);
      expect(succeeded(run)).toEqual({ code: 0, stderr: "" });
      const preview = JSON.parse(run.stdout) as {
        dryRun: boolean;
        method: string;
        url: string;
        headers: Record<string, string>;
        body: Record<string, unknown>;
        quote: Quote;
      };
      expect(preview.dryRun).toBe(true);
      expect(preview.method).toBe("POST");
      expect(preview.url).toBe(`${API_URL}/labs/pages/packs`);
      expect(typeof preview.headers["Idempotency-Key"]).toBe("string");
      expect(preview.body).toEqual({
        quoteId: preview.quote.quoteId,
        expectedAmount: preview.quote.amount,
      });

      const stored = await storedQuote(preview.quote.quoteId);
      expect({
        operationId: stored.operationId,
        status: stored.status,
        amount: stored.amount,
      }).toEqual({
        operationId: "labs.pages.packs.create",
        status: "open",
        amount: preview.quote.amount,
      });
      expect(await balance()).toBe(balanceBefore);
      expect(await packs()).toEqual(packsBefore);
    },
    TIMEOUT_MS,
  );

  test(
    "a bandwidth add-on asks for its quote first, and a refused quote buys nothing: staging has no server",
    async () => {
      const balanceBefore = await balance();
      const add = ["compute", "bandwidth-addons", "buy", MISSING_SERVER, "--amount-gi-b", "10"];

      // A dry run sends the quote request and nothing else, so its 404 is the quote's.
      const dryRun = await lazco(home.home, WRITE_TOKEN, [...add, "--dry-run"]);
      expect(dryRun.code).toBe(1);
      expect(dryRun.stdout).toBe("");
      expect(errorOf(dryRun)).toMatchObject({ status: 404, code: "NOT_FOUND" });

      const run = await lazco(home.home, WRITE_TOKEN, [...add, "--yes"]);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe("");
      // No quote was shown, so no spend could follow it.
      expect(run.stderr).not.toContain("lazco: quote ");
      expect(errorOf(run)).toMatchObject({ status: 404, code: "NOT_FOUND" });
      expect(await balance()).toBe(balanceBefore);
    },
    TIMEOUT_MS,
  );

  test.skipIf(!SPEND_ALLOWED)(
    "a pack bought with its own quote charges exactly the quote, and a second run with the same key and quote replays it",
    async () => {
      const create = operations.find(
        (operation) => operation.command.join(" ") === "labs pages packs create",
      );
      // Never buy without a required key: an API that ignores the key would buy twice.
      expect(create?.idempotencyKey).toBe("required");
      expect(features.pages).toBe(true);

      await deleteLivePacks();
      const before = (await packs()).map((pack) => pack.id);
      const balanceBefore = await balance();
      const key = `cli-contract-${Date.now()}-${process.pid}`;
      let failure: unknown;
      try {
        const first = await lazco(home.home, WRITE_TOKEN, [
          ...PACK_CREATE,
          "--yes",
          "--idempotency-key",
          key,
        ]);
        expect(first.code).toBe(0);
        const quoteId = /^lazco: quote (\S+): /m.exec(first.stderr)?.[1];
        expect(typeof quoteId).toBe("string");
        const bought = JSON.parse(first.stdout) as Pack;
        expect(typeof bought.id).toBe("string");

        const quote = await storedQuote(quoteId as string);
        expect({ operationId: quote.operationId, status: quote.status }).toEqual({
          operationId: "labs.pages.packs.create",
          status: "used",
        });
        const balanceAfter = await balance();
        expect(balanceBefore - balanceAfter).toBeCloseTo(Number(quote.amount), 3);

        // The same key and the same quote make the same request, so the API replays the first answer.
        const second = await lazco(home.home, WRITE_TOKEN, [
          ...PACK_CREATE,
          "--yes",
          "--idempotency-key",
          key,
          "--quote-id",
          quote.quoteId,
          "--expected-amount",
          quote.amount,
        ]);
        expect(second.code).toBe(0);
        expect(second.stdout).toBe(first.stdout);
        expect(second.stderr).toContain(`Idempotency-Key ${key}. Nothing ran again`);
        expect(await balance()).toBe(balanceAfter);

        const added = (await packs()).map((pack) => pack.id).filter((id) => !before.includes(id));
        expect(added).toEqual([bought.id]);
      } catch (error) {
        failure = error;
      }
      // Whatever failed above, no pack this run bought is left to renew, and
      // a failed cleanup never hides the first failure.
      try {
        await deleteLivePacks();
      } catch (cleanup) {
        failure ??= cleanup;
      }
      if (failure !== undefined) {
        throw failure;
      }
    },
    TIMEOUT_MS,
  );
});
