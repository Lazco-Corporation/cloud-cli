import { CliError } from "../errors";
import { BODY_INPUT, IF_MATCH_INPUT, type Operation } from "../generate/operations";
import type { ApiRequest } from "./client";
import { guardPathParameters } from "./guard";
import type { InputValidator } from "./validate";

/**
 * The path of a spec path below the API URL. The spec names full paths such
 * as `/v1/servers`, and the API URL already ends in `/v1`, so the longest end
 * of the API URL's path that starts the spec path is dropped.
 */
export function pathBelowApiUrl(apiUrl: string, specPath: string): string {
  const segments = new URL(apiUrl).pathname.split("/").filter(Boolean);
  for (let start = 0; start < segments.length; start += 1) {
    const overlap = `/${segments.slice(start).join("/")}`;
    if (specPath.startsWith(`${overlap}/`)) {
      return specPath.slice(overlap.length);
    }
  }
  return specPath;
}

function queryValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Checks an input object (the path guard, then the spec's JSON Schema) and
 * splits it into the request: path parameters into the path, query parameters
 * into the query, `ifMatch` into `If-Match`, and the rest into the body.
 */
export function prepareRequest(
  operation: Operation,
  input: Record<string, unknown>,
  context: { apiUrl: string; validator: InputValidator },
): ApiRequest {
  const pathValues = guardPathParameters(operation.pathParameters, input);
  context.validator.check(operation.inputSchema, input);

  const path = pathBelowApiUrl(context.apiUrl, operation.path).replace(
    /\{([^}]+)\}/g,
    (_whole, name: string) => encodeURIComponent(pathValues[name] as string),
  );

  const query: Array<[string, string]> = [];
  for (const name of operation.queryParameters) {
    const value = input[name];
    if (value === undefined) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      query.push([name, queryValue(item)]);
    }
  }

  const headers: Record<string, string> = {};
  const ifMatch = input[IF_MATCH_INPUT];
  if (operation.annotation.concurrency === "etag" && typeof ifMatch === "string") {
    headers["If-Match"] = asEntityTag(ifMatch);
  }

  let body: unknown;
  if (operation.body.mode === "wrapped") {
    body = input[BODY_INPUT];
  } else if (operation.body.mode === "merged") {
    const taken = new Set([...operation.pathParameters, ...operation.queryParameters]);
    if (operation.annotation.concurrency === "etag") {
      taken.add(IF_MATCH_INPUT);
    }
    const entries = Object.entries(input).filter(([name]) => !taken.has(name));
    if (entries.length > 0 || operation.body.required) {
      body = Object.fromEntries(entries);
    }
  }

  return { method: operation.method.toUpperCase(), path, query, headers, body };
}

/** The characters of an entity tag between its quotes (RFC 9110, `etagc`). */
const ENTITY_TAG_CHARACTERS = "[\\x21\\x23-\\x7E\\x80-\\xFF]*";
/** A strong entity tag (RFC 9110, `entity-tag` without `W/`), such as `"7"`. */
export const STRONG_ENTITY_TAG = new RegExp(`^"${ENTITY_TAG_CHARACTERS}"$`);
const BARE_VERSION = new RegExp(`^${ENTITY_TAG_CHARACTERS}$`);

/**
 * An `ifMatch` as a strong entity tag. A bare version such as `7` gets its
 * quotes, because `If-Match: 7` is no entity tag. A quoted tag and `*` pass as
 * given. A weak tag is refused, because `If-Match` compares strongly and a
 * weak tag never matches, and so is a value that is no entity tag at all.
 */
export function asEntityTag(value: string): string {
  if (value === "*" || STRONG_ENTITY_TAG.test(value)) {
    return value;
  }
  if (value.startsWith("W/")) {
    throw new CliError(
      "CLI_INVALID_INPUT",
      "ifMatch is a weak entity tag, which If-Match never matches",
      [{ field: IF_MATCH_INPUT, message: 'must be a strong entity tag, such as "7"' }],
    );
  }
  if (value.length > 0 && BARE_VERSION.test(value)) {
    return `"${value}"`;
  }
  throw new CliError("CLI_INVALID_INPUT", "ifMatch is no entity tag", [
    { field: IF_MATCH_INPUT, message: 'must be a version such as 7, or an entity tag such as "7"' },
  ]);
}
