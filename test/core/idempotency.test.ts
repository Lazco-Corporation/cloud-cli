import { describe, expect, test } from "bun:test";
import { CliError } from "../../src/core/errors";
import {
  checkIdempotencyKey,
  extractIdempotencyKeyFlag,
  isReplayed,
  newIdempotencyKey,
} from "../../src/core/request/idempotency";

function refusal(run: () => unknown): CliError {
  try {
    run();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("the --idempotency-key flag", () => {
  test("is taken out of the arguments, in both forms", () => {
    expect(extractIdempotencyKeyFlag(["--name", "a", "--idempotency-key", "k-1", "x"])).toEqual({
      key: "k-1",
      rest: ["--name", "a", "x"],
    });
    expect(extractIdempotencyKeyFlag(["--idempotency-key=k=2"])).toEqual({ key: "k=2", rest: [] });
  });

  test("after -- it is a value, never the flag", () => {
    expect(extractIdempotencyKeyFlag(["--", "--idempotency-key", "k-1"])).toEqual({
      key: undefined,
      rest: ["--", "--idempotency-key", "k-1"],
    });
  });

  test("last with no value is CLI_INVALID_INPUT", () => {
    const error = refusal(() => extractIdempotencyKeyFlag(["--idempotency-key"]));
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.message).toBe("--idempotency-key needs a value");
  });

  test("given twice is CLI_INVALID_INPUT", () => {
    const error = refusal(() =>
      extractIdempotencyKeyFlag(["--idempotency-key", "a", "--idempotency-key=b"]),
    );
    expect(error.message).toBe("--idempotency-key is given twice");
  });

  test("a key the API would refuse is CLI_INVALID_INPUT", () => {
    for (const key of ["", "a b", "tab\there", "k".repeat(256), "clé"]) {
      expect(refusal(() => checkIdempotencyKey(key)).code).toBe("CLI_INVALID_INPUT");
    }
    expect(checkIdempotencyKey("!~")).toBe("!~");
  });
});

describe("keys and replays", () => {
  test("a new key is a fresh UUID v4 each time", () => {
    const first = newIdempotencyKey();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newIdempotencyKey()).not.toBe(first);
  });

  test("only Idempotent-Replayed: true is a replay", () => {
    expect(isReplayed(new Headers({ "Idempotent-Replayed": "true" }))).toBe(true);
    expect(isReplayed(new Headers({ "idempotent-replayed": "false" }))).toBe(false);
    expect(isReplayed(new Headers())).toBe(false);
  });
});
