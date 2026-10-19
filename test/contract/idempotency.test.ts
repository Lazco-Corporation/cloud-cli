import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
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

/**
 * A pack costs the organization a month of it each run, with no refund on
 * delete, so the purchase runs only when asked: CI asks on a push to `main`.
 */
const SPEND_ALLOWED = process.env.LAZCO_CONTRACT_SPEND === "1";

const operations = await stagingOperations();
const features = await stagingFeatures(READ_TOKEN);
let home: Awaited<ReturnType<typeof temporaryHome>>;

type Pack = { id: string; status: string };
/** The pack statuses that still renew, so a delete is due. */
const RENEWING: ReadonlySet<string> = new Set(["active", "renewal_grace", "suspended"]);

beforeAll(async () => {
  home = await temporaryHome();
});

afterAll(async () => {
  await home.cleanup();
});

function succeeded(run: Run): { code: number; stderr: string } {
  return { code: run.code, stderr: run.stderr };
}

async function packs(): Promise<Pack[]> {
  const run = await lazco(home.home, READ_TOKEN, ["labs", "pages", "entitlement", "get"]);
  expect(succeeded(run)).toEqual({ code: 0, stderr: "" });
  return (JSON.parse(run.stdout) as { packs?: Pack[] }).packs ?? [];
}

/**
 * Deletes every pack that still renews. Only this test buys packs in the
 * contract organization, so one left by a run that stopped early is deleted
 * here, before it renews.
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

  test.skipIf(!SPEND_ALLOWED)(
    "a pack bought twice with one --idempotency-key prints the same JSON, notes the replay, and is bought once",
    async () => {
      const create = operations.find(
        (operation) => operation.command.join(" ") === "labs pages packs create",
      );
      // Never buy without a required key: an API that ignores the key would buy twice.
      expect(create?.idempotencyKey).toBe("required");
      expect(features.pages).toBe(true);

      await deleteLivePacks();
      const before = (await packs()).map((pack) => pack.id);
      const key = `cli-contract-${Date.now()}-${process.pid}`;
      const args = [...PACK_CREATE, "--yes", "--idempotency-key", key];
      let failure: unknown;
      try {
        const first = await lazco(home.home, WRITE_TOKEN, args);
        expect(succeeded(first)).toEqual({ code: 0, stderr: "" });
        const bought = JSON.parse(first.stdout) as Pack;
        expect(typeof bought.id).toBe("string");

        const second = await lazco(home.home, WRITE_TOKEN, args);
        expect(second.code).toBe(0);
        expect(second.stdout).toBe(first.stdout);
        expect(second.stderr).toContain(`Idempotency-Key ${key}. Nothing ran again`);

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
