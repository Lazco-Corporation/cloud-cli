import { CliError } from "../errors";

/** One problem with one input property, as `details` of `CLI_INVALID_INPUT` lists it. */
export type InputProblem = { field: string; message: string };

const ENCODED_SEPARATOR = /%2e|%2f|%5c/i;
const QUERY_SYNTAX = /[?&=]/;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function decodesTwice(value: string): boolean {
  try {
    const once = decodeURIComponent(value);
    return once !== value && decodeURIComponent(once) !== once;
  } catch {
    return false;
  }
}

/** Why a path parameter value is refused, or `undefined` when it may be sent. */
export function pathValueProblem(value: string): string | undefined {
  if (value.length === 0) {
    return "must not be empty";
  }
  if (hasControlCharacter(value)) {
    return "must not hold a control character";
  }
  if (value.includes("..")) {
    return "must not hold ..";
  }
  if (ENCODED_SEPARATOR.test(value)) {
    return "must not hold an encoded dot, slash or backslash";
  }
  if (QUERY_SYNTAX.test(value)) {
    return "must not hold ?, & or =";
  }
  if (decodesTwice(value)) {
    return "must not be encoded twice";
  }
  return undefined;
}

/**
 * Checks every path parameter before any request, so a value can never walk
 * to another route. Returns each value as text, ready for `encodeURIComponent`.
 */
export function guardPathParameters(
  names: readonly string[],
  input: Record<string, unknown>,
): Record<string, string> {
  const problems: InputProblem[] = [];
  const values: Record<string, string> = {};
  for (const name of names) {
    const raw = input[name];
    if (raw === undefined) {
      continue;
    }
    if (typeof raw !== "string" && typeof raw !== "number") {
      problems.push({ field: name, message: "must be a string" });
      continue;
    }
    const value = String(raw);
    const problem = pathValueProblem(value);
    if (problem) {
      problems.push({ field: name, message: problem });
    } else {
      values[name] = value;
    }
  }
  if (problems.length > 0) {
    throw new CliError("CLI_INVALID_INPUT", "A path parameter was refused", problems);
  }
  return values;
}
