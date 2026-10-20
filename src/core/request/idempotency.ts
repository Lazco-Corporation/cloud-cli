import { randomUUID } from "node:crypto";
import { CliError } from "../errors";
import { extractValueFlag } from "./valueFlag";

/** The operation flag that gives a key of the caller's choice. */
export const IDEMPOTENCY_KEY_FLAG = "idempotency-key";
/** The answer header of a stored first result sent again. */
export const REPLAYED_HEADER = "idempotent-replayed";

/** The API's own rule: 1 to 255 printable ASCII characters, no space. */
const VALID_KEY = /^[\x21-\x7E]{1,255}$/;

/** A new key for one command run or one tool call. */
export function newIdempotencyKey(): string {
  return randomUUID();
}

/** The key as given, or `CLI_INVALID_INPUT` before any request when the API would refuse it. */
export function checkIdempotencyKey(value: string): string {
  if (!VALID_KEY.test(value)) {
    throw new CliError("CLI_INVALID_INPUT", `--${IDEMPOTENCY_KEY_FLAG} is not a valid key`, [
      {
        field: IDEMPOTENCY_KEY_FLAG,
        message: "must be 1 to 255 printable ASCII characters, with no space",
      },
    ]);
  }
  return value;
}

/** True when the answer is the stored first result of its key. */
export function isReplayed(headers: Headers): boolean {
  return headers.get(REPLAYED_HEADER)?.trim().toLowerCase() === "true";
}

/**
 * Takes `--idempotency-key` out of a command's arguments, before `--`, and
 * returns the rest. The flag is an operation flag, never an input property.
 */
export function extractIdempotencyKeyFlag(tokens: readonly string[]): {
  key: string | undefined;
  rest: string[];
} {
  const { value, rest } = extractValueFlag(tokens, IDEMPOTENCY_KEY_FLAG, checkIdempotencyKey);
  return { key: value, rest };
}
