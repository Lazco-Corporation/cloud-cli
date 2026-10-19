import { CliError } from "../core/errors";
import type { InputProblem } from "../core/request/guard";
import { IDEMPOTENCY_KEY_FLAG } from "../core/request/idempotency";
import type { JsonSchema } from "../core/spec/types";
import { isGlobalFlagName } from "./globalFlags";

type ScalarKind = "string" | "number" | "integer" | "boolean";
/** `auto`: a union of scalar types, read as a number or a boolean when it looks like one. */
export type FlagKind = ScalarKind | "auto";

export type FlagSpec = {
  flag: string;
  property: string;
  kind: FlagKind;
  repeated: boolean;
  required: boolean;
  description: string;
};

const SCALAR_KINDS = new Set<string>(["string", "number", "integer", "boolean"]);
const NUMBER_TEXT = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** `regionSlug` as `region-slug`, or `undefined` when the name cannot be a flag. */
export function kebabCase(name: string): string | undefined {
  const flag = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_.\s]+/g, "-")
    .toLowerCase();
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(flag) ? flag : undefined;
}

function scalarKind(schema: JsonSchema): ScalarKind | undefined {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const kinds = new Set(schema.enum.map((value) => typeof value));
    if (kinds.size === 1 && (kinds.has("string") || kinds.has("number") || kinds.has("boolean"))) {
      return [...kinds][0] as ScalarKind;
    }
    return undefined;
  }
  if (schema.const !== undefined) {
    const kind = typeof schema.const;
    return kind === "string" || kind === "number" || kind === "boolean" ? kind : undefined;
  }
  const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter(
    (type) => type !== "null" && type !== undefined,
  );
  if (types.length === 1 && SCALAR_KINDS.has(types[0] as string)) {
    return types[0] as ScalarKind;
  }
  return undefined;
}

/** How a property can be given as a flag, or `undefined` when only `--json` can carry it. */
function flagShape(schema: JsonSchema): { kind: FlagKind; repeated: boolean } | undefined {
  const scalar = scalarKind(schema);
  if (scalar) {
    return { kind: scalar, repeated: false };
  }
  if (schema.type === "array" && schema.items && typeof schema.items === "object") {
    const item = scalarKind(schema.items as JsonSchema);
    return item ? { kind: item, repeated: true } : undefined;
  }
  const branches = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (
    Array.isArray(branches) &&
    branches.length > 0 &&
    branches.every((branch) => scalarKind(branch))
  ) {
    return { kind: "auto", repeated: false };
  }
  return undefined;
}

/**
 * The flags of an input schema. A property becomes a flag when it is a scalar
 * or a list of scalars, is not positional, and its kebab-case name clashes
 * with no global flag, no operation flag such as `--idempotency-key`, and no
 * other property. Every other property is given through `--json`.
 */
export function flagSpecs(schema: JsonSchema, positionals: readonly string[]): FlagSpec[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required ?? []) as string[]);
  const candidates = Object.entries(properties)
    .filter(([property]) => !positionals.includes(property))
    .map(([property, propertySchema]) => ({
      property,
      propertySchema,
      flag: kebabCase(property),
      shape: flagShape(propertySchema),
    }));
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.flag) {
      counts.set(candidate.flag, (counts.get(candidate.flag) ?? 0) + 1);
    }
  }
  const specs: FlagSpec[] = [];
  for (const { property, propertySchema, flag, shape } of candidates) {
    if (
      !flag ||
      !shape ||
      counts.get(flag) !== 1 ||
      isGlobalFlagName(flag) ||
      flag === IDEMPOTENCY_KEY_FLAG
    ) {
      continue;
    }
    specs.push({
      flag,
      property,
      kind: shape.kind,
      repeated: shape.repeated,
      required: required.has(property),
      description: typeof propertySchema.description === "string" ? propertySchema.description : "",
    });
  }
  return specs;
}

function coerce(kind: FlagKind, text: string): unknown {
  if (kind === "number" || kind === "integer") {
    return NUMBER_TEXT.test(text) ? Number(text) : text;
  }
  if (kind === "boolean") {
    return text === "true" ? true : text === "false" ? false : text;
  }
  if (kind === "auto") {
    if (NUMBER_TEXT.test(text)) return Number(text);
    if (text === "true" || text === "false") return text === "true";
  }
  return text;
}

function invalid(message: string, problems: InputProblem[]): CliError {
  return new CliError("CLI_INVALID_INPUT", message, problems);
}

/** The payload of `--json`, which must be one JSON object. */
export function parsePayload(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw invalid("--json is not valid JSON", [
      { field: "json", message: error instanceof Error ? error.message : "is not valid JSON" },
    ]);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("--json must be one JSON object", [
      { field: "json", message: "must be an object" },
    ]);
  }
  return value as Record<string, unknown>;
}

/**
 * The input object of a command from its arguments: positionals in order,
 * then flags, then the `--json` payload. A property given twice is refused,
 * and a payload key is always an input property, never a global flag.
 */
export function buildInput(options: {
  schema: JsonSchema;
  positionals: readonly string[];
  tokens: readonly string[];
  payload: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  const specs = flagSpecs(options.schema, options.positionals);
  const byFlag = new Map(specs.map((spec) => [spec.flag, spec]));
  const fromArguments: Record<string, unknown> = {};
  const positionalValues: string[] = [];
  const problems: InputProblem[] = [];

  const set = (spec: FlagSpec, value: unknown): void => {
    if (spec.repeated) {
      fromArguments[spec.property] = [
        ...((fromArguments[spec.property] as unknown[]) ?? []),
        value,
      ];
    } else if (Object.hasOwn(fromArguments, spec.property)) {
      problems.push({ field: spec.property, message: `--${spec.flag} is given twice` });
    } else {
      fromArguments[spec.property] = value;
    }
  };

  for (let index = 0; index < options.tokens.length; index += 1) {
    const token = options.tokens[index] as string;
    if (token === "--") {
      positionalValues.push(...options.tokens.slice(index + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      positionalValues.push(token);
      continue;
    }
    const match = /^--([a-z0-9-]+)(?:=([\s\S]*))?$/.exec(token);
    const name = match?.[1] ?? token;
    const inline = match?.[2];
    let spec = byFlag.get(name);
    if (spec?.kind === "boolean" && !spec.repeated) {
      set(spec, inline === undefined ? true : coerce("boolean", inline));
      continue;
    }
    if (!spec && name.startsWith("no-")) {
      spec = byFlag.get(name.slice(3));
      if (spec?.kind === "boolean" && !spec.repeated && inline === undefined) {
        set(spec, false);
        continue;
      }
      spec = undefined;
    }
    if (!spec) {
      problems.push({
        field: name.replace(/^-+/, ""),
        message: `${token.split("=")[0]} is not a flag of this command`,
      });
      continue;
    }
    const value = inline ?? options.tokens[index + 1];
    if (value === undefined) {
      problems.push({ field: spec.property, message: `--${spec.flag} needs a value` });
      continue;
    }
    if (inline === undefined) {
      index += 1;
    }
    set(spec, coerce(spec.kind, value));
  }

  if (positionalValues.length > options.positionals.length) {
    problems.push({
      field: "arguments",
      message: `expects at most ${options.positionals.length} argument${options.positionals.length === 1 ? "" : "s"} (${options.positionals.join(", ") || "none"})`,
    });
  }
  positionalValues.slice(0, options.positionals.length).forEach((value, position) => {
    fromArguments[options.positionals[position] as string] = value;
  });

  for (const key of Object.keys(options.payload ?? {})) {
    if (Object.hasOwn(fromArguments, key)) {
      problems.push({ field: key, message: "is given both as an argument and in --json" });
    }
  }
  if (problems.length > 0) {
    throw invalid("The arguments are not valid", problems);
  }
  return { ...options.payload, ...fromArguments };
}
