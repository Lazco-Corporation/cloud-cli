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

beforeAll(async () => {
  home = await temporaryHome();
});

afterAll(async () => {
  await home.cleanup();
});

function succeeded(run: Run): { code: number; stderr: string } {
  return { code: run.code, stderr: run.stderr };
}

async function packIds(): Promise<string[]> {
  const run = await lazco(home.home, READ_TOKEN, ["labs", "pages", "entitlement", "get"]);
  expect(succeeded(run)).toEqual({ code: 0, stderr: "" });
  return ((JSON.parse(run.stdout) as { packs: Pack[] }).packs ?? []).map((pack) => pack.id);
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

      const before = await packIds();
      const key = `cli-contract-${Date.now()}-${process.pid}`;
      const args = [...PACK_CREATE, "--yes", "--idempotency-key", key];
      let bought: Pack | undefined;
      try {
        const first = await lazco(home.home, WRITE_TOKEN, args);
        expect(succeeded(first)).toEqual({ code: 0, stderr: "" });
        bought = JSON.parse(first.stdout) as Pack;
        expect(typeof bought.id).toBe("string");

        const second = await lazco(home.home, WRITE_TOKEN, args);
        expect(second.code).toBe(0);
        expect(second.stdout).toBe(first.stdout);
        expect(second.stderr).toContain(`Idempotency-Key ${key}. Nothing ran again`);

        const added = (await packIds()).filter((id) => !before.includes(id));
        expect(added).toEqual([bought.id]);
      } finally {
        if (bought?.id) {
          const deleted = await lazco(home.home, WRITE_TOKEN, [
            "labs",
            "pages",
            "packs",
            "delete",
            bought.id,
            "--yes",
          ]);
          expect(succeeded(deleted)).toEqual({ code: 0, stderr: "" });
        }
      }
    },
    TIMEOUT_MS,
  );
});
