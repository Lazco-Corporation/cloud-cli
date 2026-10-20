import { CliError } from "./errors";
import { EXPECTED_AMOUNT_INPUT, QUOTE_ID_INPUT } from "./generate/operations";
import { extractValueFlag, flagProblem } from "./request/valueFlag";

/** The operation flag that sends a quote the caller already has. */
export const QUOTE_ID_FLAG = "quote-id";
/** The operation flag that goes with `--quote-id`: the quote's amount. */
export const EXPECTED_AMOUNT_FLAG = "expected-amount";

/** What `expectedAmount` takes: TWD with at most 3 decimals, as the spend body's pattern says. */
const EXPECTED_AMOUNT_TEXT = /^[0-9]+(\.[0-9]{1,3})?$/;
/** A money value of a quote: a decimal string, negative for a discount line. */
const MONEY_TEXT = /^(-?)([0-9]+)(?:\.([0-9]+))?$/;

/**
 * A quote as the API answers it. Every money value stays the decimal string
 * the API sent: it is never turned into a number, rounded or taxed.
 */
export type Quote = { quoteId: string; amount: string; [field: string]: unknown };

/**
 * The body of a quote answer, or `CLI_BAD_RESPONSE` when it holds no quote id,
 * or an amount the spend cannot send back as `expectedAmount`. That is found
 * before anyone is asked, never after a yes.
 */
export function readQuote(body: unknown, source: string): Quote {
  const value = body as { quoteId?: unknown; amount?: unknown } | null;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.quoteId !== "string" ||
    value.quoteId === "" ||
    typeof value.amount !== "string" ||
    !EXPECTED_AMOUNT_TEXT.test(value.amount)
  ) {
    throw new CliError(
      "CLI_BAD_RESPONSE",
      `${source} answered no quote with a quoteId and an amount of TWD with at most 3 decimals`,
    );
  }
  return value as Quote;
}

/** An `--expected-amount` as given, or `CLI_INVALID_INPUT` before any request. */
export function checkExpectedAmount(value: string): string {
  if (!EXPECTED_AMOUNT_TEXT.test(value)) {
    throw new CliError(
      "CLI_INVALID_INPUT",
      `--${EXPECTED_AMOUNT_FLAG} is not an amount of TWD with at most 3 decimals`,
      [
        {
          field: EXPECTED_AMOUNT_FLAG,
          message: "must be the quote's amount, such as 402.500 or 402.5",
        },
      ],
    );
  }
  return value;
}

/** A decimal string as sign, whole part and decimals, with no zero that changes nothing. */
function decimalParts(text: string): { negative: boolean; whole: string; decimals: string } | null {
  const match = MONEY_TEXT.exec(text);
  if (!match) {
    return null;
  }
  const whole = (match[2] as string).replace(/^0+(?=\d)/, "");
  const decimals = (match[3] ?? "").replace(/0+$/, "");
  const zero = whole === "0" && decimals === "";
  return { negative: match[1] === "-" && !zero, whole, decimals };
}

/** True when two decimal strings are the same amount, such as `402.5` and `402.500`. */
export function sameAmount(left: string, right: string): boolean {
  const one = decimalParts(left);
  const other = decimalParts(right);
  return (
    one !== null &&
    other !== null &&
    one.negative === other.negative &&
    one.whole === other.whole &&
    one.decimals === other.decimals
  );
}

/** TWD for a person, with the decimals the value carries: `"52.500"` is `NT$52.5`. */
export function formatTwd(amount: unknown): string {
  if (amount === undefined || amount === null) {
    return "an amount the API did not send";
  }
  const parts = typeof amount === "string" ? decimalParts(amount) : null;
  if (parts === null) {
    // A malformed figure is still shown, as the API sent it, never hidden.
    return `${JSON.stringify(amount)} TWD`;
  }
  const number = parts.decimals === "" ? parts.whole : `${parts.whole}.${parts.decimals}`;
  return `${parts.negative ? "-" : ""}NT$${number}`;
}

const INTERVALS: Readonly<Record<string, string>> = {
  hour: "every hour",
  "30_days": "every 30 days",
  calendar_month: "every calendar month",
};

type Period = { start?: unknown; end?: unknown } | null | undefined;

function periodText(period: Period): string | undefined {
  if (
    period === null ||
    typeof period !== "object" ||
    typeof period.start !== "string" ||
    typeof period.end !== "string"
  ) {
    return undefined;
  }
  return `${period.start} to ${period.end}`;
}

/** True for a figure the API sent. A malformed one is still shown, as the API sent it. */
function isGiven(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * The quote for a person, one line each: the amount, each line, the period,
 * the recurring charge and its interval, the account balance, and the expiry.
 */
export function describeQuote(quote: Quote): string[] {
  const lines = [`quote ${quote.quoteId}: ${formatTwd(quote.amount)} from the account balance`];
  const items = Array.isArray(quote.lines) ? quote.lines : [];
  for (const item of items as Array<Record<string, unknown> | null>) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const label = typeof item.description === "string" ? item.description : String(item.code);
    const period = periodText(item.period as Period);
    const amount = isGiven(item.amount) ? `: ${formatTwd(item.amount)}` : "";
    lines.push(`  ${label}${amount}${period ? ` (${period})` : ""}`);
  }
  const period = periodText(quote.period as Period);
  if (period) {
    lines.push(`period: ${period}`);
  }
  const recurring = quote.recurring as {
    amount?: unknown;
    interval?: unknown;
    startsAt?: unknown;
  } | null;
  if (recurring !== null && typeof recurring === "object") {
    const interval = INTERVALS[String(recurring.interval)] ?? `every ${String(recurring.interval)}`;
    const from = typeof recurring.startsAt === "string" ? `, from ${recurring.startsAt}` : "";
    lines.push(`then ${formatTwd(recurring.amount)} ${interval}${from}`);
  }
  if (isGiven(quote.accountBalance)) {
    lines.push(`account balance: ${formatTwd(quote.accountBalance)}`);
  }
  if (quote.sufficient === false) {
    lines.push(
      "the account balance is short of this amount. Top up the account balance before you spend",
    );
  }
  if (isGiven(quote.expiresAt)) {
    lines.push(`the quote expires at ${String(quote.expiresAt)}, and is good for one spend`);
  }
  return lines;
}

/** A quote the caller already has: its id and its amount. */
export type GivenQuote = Pick<Quote, "quoteId" | "amount">;

/**
 * Takes `--quote-id` and `--expected-amount` out of a spend command's
 * arguments. They go together, so one without the other fails before any
 * request.
 */
export function extractQuoteFlags(tokens: readonly string[]): {
  given: GivenQuote | undefined;
  rest: string[];
} {
  const id = extractValueFlag(tokens, QUOTE_ID_FLAG, (value) => value);
  const amount = extractValueFlag(id.rest, EXPECTED_AMOUNT_FLAG, checkExpectedAmount);
  if (id.value === undefined && amount.value === undefined) {
    return { given: undefined, rest: amount.rest };
  }
  if (id.value === undefined || amount.value === undefined) {
    const missing = id.value === undefined ? QUOTE_ID_FLAG : EXPECTED_AMOUNT_FLAG;
    throw flagProblem(
      missing,
      `--${QUOTE_ID_FLAG} and --${EXPECTED_AMOUNT_FLAG} go together: --${missing} is missing`,
    );
  }
  return { given: { quoteId: id.value, amount: amount.value }, rest: amount.rest };
}

/** The two body fields of a spend request that carry a quote. */
export function quoteFields(quote: GivenQuote): Record<string, string> {
  return { [QUOTE_ID_INPUT]: quote.quoteId, [EXPECTED_AMOUNT_INPUT]: quote.amount };
}
