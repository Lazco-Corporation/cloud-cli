import type Ajv2020 from "ajv/dist/2020.js";
import {
  HTTP_METHODS,
  type HttpMethod,
  type JsonSchema,
  type OpenApiDocument,
  type OpenApiOperation,
  type OpenApiParameter,
} from "../spec/types";
import {
  type Annotation,
  createAnnotationChecker,
  KNOWN_UPLOADERS,
  type OperationKind,
  type UploaderInput,
} from "./annotation";
import { lookupPointer, resolveReferences, UnresolvableReferenceError } from "./refs";

/** First command words that the hand-written commands own. */
export const RESERVED_FIRST_WORDS: ReadonlySet<string> = new Set(["auth", "profile", "mcp"]);

/** The extra input of an operation with `concurrency: etag`. */
export const IF_MATCH_INPUT = "ifMatch";
/** The input that holds the whole body when it cannot be merged. */
export const BODY_INPUT = "body";
/** The header a spend operation requires and a few others take, which the core fills itself. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
/** The body field of a spend operation that names its quote. */
export const QUOTE_ID_INPUT = "quoteId";
/** The body field of a spend operation that repeats its quote's amount. */
export const EXPECTED_AMOUNT_INPUT = "expectedAmount";
/** The two body fields a spend command fills from its quote, never from its input. */
export const QUOTE_INPUTS: readonly string[] = [QUOTE_ID_INPUT, EXPECTED_AMOUNT_INPUT];

/** Whether an operation declares `Idempotency-Key`, and how. */
export type IdempotencyKeyUse = "required" | "optional";

/**
 * How the input object maps onto the body. `merged`: every input property that
 * is not a parameter is a body property. `wrapped`: the input property `body`
 * is the whole body. `none`: the operation takes no body. `upload`: the
 * uploader of that name takes the input and builds the body itself.
 */
export type BodyMapping =
  | { mode: "none" }
  | { mode: "merged"; required: boolean }
  | { mode: "wrapped"; required: boolean }
  | { mode: "upload"; uploader: string };

export type Operation = {
  operationId: string;
  method: HttpMethod;
  /** The path template of the spec, such as `/v1/servers/{serverId}`. */
  path: string;
  summary: string;
  description: string;
  annotation: Annotation;
  kind: OperationKind;
  command: readonly string[];
  toolName: string | null;
  feature: string | null;
  /** The JSON Schema of the one input object, self-contained. */
  inputSchema: JsonSchema;
  /**
   * The input of the command: `inputSchema`, less `quoteId` and
   * `expectedAmount` for a spend operation, which its command fills itself.
   */
  commandInputSchema: JsonSchema;
  pathParameters: readonly string[];
  queryParameters: readonly string[];
  /** The command's positional inputs: the path parameters, then an uploader's own. */
  positionals: readonly string[];
  body: BodyMapping;
  /** `Idempotency-Key` as the spec declares it, or `null`. Never an input: the core sends it. */
  idempotencyKey: IdempotencyKeyUse | null;
  /** The quote operation that a spend operation's `x-lazco.quote` names, else `null`. */
  quote: Operation | null;
  /** True when a spend operation's `x-lazco.quote` names this one. */
  isQuote: boolean;
};

export type SkipReason =
  | "invalid-annotation"
  | "no-uploader"
  | "etag-without-get"
  | "reserved-word"
  | "command-is-group"
  | "duplicate-command"
  | "duplicate-tool"
  | "unresolvable-ref"
  | "unsupported-body"
  | "unsupported-parameter"
  | "no-quote";

export type SkippedOperation = {
  method: HttpMethod;
  path: string;
  operationId: string | null;
  reason: SkipReason;
  message: string;
};

export type GeneratedSurface = {
  operations: readonly Operation[];
  skipped: readonly SkippedOperation[];
};

class SkipError extends Error {
  readonly reason: SkipReason;

  constructor(reason: SkipReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The one-line warning for a skipped operation. */
export function describeSkip(skip: SkippedOperation): string {
  const name = skip.operationId ? ` (${skip.operationId})` : "";
  return `skipped ${skip.method.toUpperCase()} ${skip.path}${name}: ${skip.message}`;
}

/** Every exposed operation as a command and at most one tool, and every operation skipped. */
export function generateSurface(document: OpenApiDocument, ajv: Ajv2020): GeneratedSurface {
  const checkAnnotation = createAnnotationChecker(ajv);
  const candidates: Operation[] = [];
  const skipped: SkippedOperation[] = [];
  const namedQuotes = new Set<string>();
  const skip = (operation: Operation, reason: SkipReason, message: string): void => {
    skipped.push({
      method: operation.method,
      path: operation.path,
      operationId: operation.operationId,
      reason,
      message,
    });
  };

  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const source = pathItem[method];
      if (!source) {
        continue;
      }
      // Read as given, so a quote stays a quote even when its spend is hidden or skipped.
      const quoteName = rawSpendQuote(source["x-lazco"]);
      if (quoteName !== undefined) {
        namedQuotes.add(quoteName);
      }
      const check = checkAnnotation(source["x-lazco"]);
      if (!check.exposed) {
        continue;
      }
      try {
        if ("problem" in check) {
          throw new SkipError("invalid-annotation", check.problem);
        }
        candidates.push(
          buildOperation(document, path, method, source, check.annotation, pathItem.parameters),
        );
      } catch (error) {
        if (!(error instanceof SkipError)) {
          throw error;
        }
        skipped.push({
          method,
          path,
          operationId: source.operationId ?? null,
          reason: error.reason,
          message: error.message,
        });
      }
    }
  }

  // A spend without a usable quote is dropped first, so it never makes another operation a duplicate.
  const candidateIds = new Map(candidates.map((operation) => [operation.operationId, operation]));
  const usable = candidates.filter((operation) => {
    const problem = quoteProblem(operation, candidateIds);
    if (problem !== undefined) {
      skip(operation, "no-quote", problem);
    }
    return problem === undefined;
  });

  const byCommand = groupBy(usable, (operation) => operation.command.join(" "));
  const byTool = groupBy(
    usable.filter((operation) => operation.toolName !== null),
    (operation) => operation.toolName as string,
  );
  const commandKeys = [...byCommand.keys()];
  const kept: Operation[] = [];
  for (const operation of usable) {
    const command = operation.command.join(" ");
    if ((byCommand.get(command)?.length ?? 0) > 1) {
      skip(operation, "duplicate-command", `another operation also uses the command "${command}"`);
    } else if (operation.toolName && (byTool.get(operation.toolName)?.length ?? 0) > 1) {
      skip(
        operation,
        "duplicate-tool",
        `another operation also uses the tool "${operation.toolName}"`,
      );
    } else if (commandKeys.some((other) => other.startsWith(`${command} `))) {
      skip(operation, "command-is-group", `"${command}" is also a group of other commands`);
    } else {
      kept.push(operation);
    }
  }

  // Only a write operation can be a quote, so a wrong name in the spec never hides a read tool.
  const marked = kept.map((operation) => ({
    ...operation,
    isQuote: operation.kind === "write" && namedQuotes.has(operation.operationId),
  }));
  const byOperationId = new Map(marked.map((operation) => [operation.operationId, operation]));
  const operations: Operation[] = [];
  for (const operation of marked) {
    if (operation.kind !== "spend") {
      operations.push(operation);
      continue;
    }
    const name = operation.annotation.quote as string;
    const quote = byOperationId.get(name);
    if (quote === undefined) {
      skip(operation, "no-quote", `its quote operation "${name}" is skipped`);
    } else {
      operations.push({ ...operation, quote });
    }
  }
  return { operations, skipped };
}

/** Why a spend operation's quote operation cannot serve it, or `undefined` when it can. */
function quoteProblem(
  operation: Operation,
  candidates: ReadonlyMap<string, Operation>,
): string | undefined {
  if (operation.kind !== "spend") {
    return undefined;
  }
  const name = operation.annotation.quote as string;
  const quote = candidates.get(name);
  if (quote === undefined) {
    return `its quote operation "${name}" is not in the spec, or is skipped`;
  }
  // A quote stores a quote and charges nothing: any other kind is a mistake of the spec.
  if (quote.kind !== "write") {
    return `its quote operation "${name}" is ${quote.kind}, not write`;
  }
  return undefined;
}

/** The `x-lazco.quote` of a raw spend annotation, whether or not the rest of it is valid. */
function rawSpendQuote(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const { kind, quote } = value as { kind?: unknown; quote?: unknown };
  return kind === "spend" && typeof quote === "string" ? quote : undefined;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  return groups;
}

function buildOperation(
  document: OpenApiDocument,
  path: string,
  method: HttpMethod,
  source: OpenApiOperation,
  annotation: Annotation,
  pathLevelParameters: OpenApiOperation["parameters"],
): Operation {
  const command = annotation.cli.split(" ");
  if (RESERVED_FIRST_WORDS.has(command[0] as string)) {
    throw new SkipError(
      "reserved-word",
      `the command word "${command[0]}" belongs to lazco itself`,
    );
  }
  const uploader =
    annotation.upload === undefined ? undefined : KNOWN_UPLOADERS.get(annotation.upload);
  if (annotation.upload !== undefined && uploader === undefined) {
    throw new SkipError("no-uploader", `this version has no uploader "${annotation.upload}"`);
  }
  if (annotation.concurrency === "etag" && !document.paths[path]?.get) {
    throw new SkipError("etag-without-get", "concurrency etag needs a GET at the same path");
  }
  if (annotation.kind === "spend" && annotation.quote === undefined) {
    throw new SkipError("no-quote", "a spend operation needs x-lazco.quote");
  }

  const parameters = collectParameters(document, pathLevelParameters, source.parameters);
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const pathParameters: string[] = [];
  const queryParameters: string[] = [];
  let idempotencyKey: IdempotencyKeyUse | null = null;
  for (const parameter of parameters) {
    if (
      parameter.in === "header" &&
      parameter.name.toLowerCase() === IDEMPOTENCY_KEY_HEADER.toLowerCase()
    ) {
      idempotencyKey = parameter.required ? "required" : "optional";
      continue;
    }
    if (parameter.in === "header" || parameter.in === "cookie") {
      if (parameter.required) {
        throw new SkipError(
          "unsupported-parameter",
          `the ${parameter.in} parameter "${parameter.name}" is required`,
        );
      }
      continue;
    }
    if (Object.hasOwn(properties, parameter.name)) {
      throw new SkipError(
        "unsupported-parameter",
        `the parameter "${parameter.name}" is listed twice`,
      );
    }
    const schema: JsonSchema = { ...(parameter.schema ?? {}) };
    if (parameter.description && schema.description === undefined) {
      schema.description = parameter.description;
    }
    properties[parameter.name] = schema;
    if (parameter.in === "path") {
      pathParameters.push(parameter.name);
      required.push(parameter.name);
    } else {
      queryParameters.push(parameter.name);
      if (parameter.required) {
        required.push(parameter.name);
      }
    }
  }
  const templateOrder = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string);
  const missingPathParameter = templateOrder.find((name) => !pathParameters.includes(name));
  if (missingPathParameter) {
    throw new SkipError(
      "unsupported-parameter",
      `the path parameter "${missingPathParameter}" is not described`,
    );
  }
  // Positionals follow the path, whatever order the spec lists the parameters in.
  pathParameters.sort((left, right) => templateOrder.indexOf(left) - templateOrder.indexOf(right));
  if (annotation.concurrency === "etag") {
    if (Object.hasOwn(properties, IF_MATCH_INPUT)) {
      throw new SkipError(
        "unsupported-parameter",
        `the parameter "${IF_MATCH_INPUT}" clashes with the ETag input`,
      );
    }
    properties[IF_MATCH_INPUT] = {
      type: "string",
      minLength: 1,
      description:
        "The ETag of the version this change is based on, sent as If-Match. Without it, the current ETag is read first.",
    };
  }

  const body =
    uploader === undefined
      ? mergeBody(document, source, properties, required)
      : addUploaderInput(annotation.upload as string, uploader, properties, required);
  let resolved: ReturnType<typeof resolveReferences>;
  try {
    resolved = resolveReferences(document, {
      type: "object",
      properties,
      required,
      additionalProperties: body.additionalProperties,
    });
  } catch (error) {
    if (error instanceof UnresolvableReferenceError) {
      throw new SkipError("unresolvable-ref", error.message);
    }
    throw error;
  }
  const inputSchema: JsonSchema = resolved.schema;
  if (Object.keys(resolved.definitions).length > 0) {
    inputSchema.$defs = resolved.definitions;
  }
  if (annotation.kind === "spend" && idempotencyKey !== "required") {
    throw new SkipError(
      "unsupported-parameter",
      `a spend operation must declare the header "${IDEMPOTENCY_KEY_HEADER}" as required`,
    );
  }
  const commandInputSchema =
    annotation.kind === "spend"
      ? withoutQuoteInputs(inputSchema, body.mapping, [...pathParameters, ...queryParameters])
      : inputSchema;

  return {
    operationId: source.operationId ?? `${method} ${path}`,
    method,
    path,
    summary: source.summary ?? "",
    description: source.description ?? "",
    annotation,
    kind: annotation.kind,
    command,
    toolName: annotation.mcp === false ? null : annotation.mcp.name,
    feature: annotation.feature ?? null,
    inputSchema,
    commandInputSchema,
    pathParameters,
    queryParameters,
    positionals: [...pathParameters, ...(uploader?.positionals ?? [])],
    body: body.mapping,
    idempotencyKey,
    quote: null,
    isQuote: false,
  };
}

/**
 * A spend operation's input less `quoteId` and `expectedAmount`, which must
 * be required top-level body fields so its command can fill them.
 */
function withoutQuoteInputs(
  schema: JsonSchema,
  mapping: BodyMapping,
  parameters: readonly string[],
): JsonSchema {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  // A parameter of the same name would carry the field in the URL, not in the body.
  const missing = QUOTE_INPUTS.filter(
    (name) =>
      !Object.hasOwn(properties, name) || !required.includes(name) || parameters.includes(name),
  );
  if (mapping.mode !== "merged" || missing.length > 0) {
    throw new SkipError(
      "unsupported-body",
      `a spend operation's body must require ${QUOTE_INPUTS.join(" and ")}`,
    );
  }
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).filter(([name]) => !QUOTE_INPUTS.includes(name)),
    ),
    required: required.filter((name) => !QUOTE_INPUTS.includes(name)),
  };
}

/**
 * Puts an uploader's input in place of the body: the uploader builds the body
 * from it, so the body's own schema is never an input.
 */
function addUploaderInput(
  name: string,
  uploader: UploaderInput,
  properties: Record<string, JsonSchema>,
  required: string[],
): { mapping: BodyMapping; additionalProperties: unknown } {
  for (const [property, schema] of Object.entries(uploader.properties)) {
    if (Object.hasOwn(properties, property)) {
      throw new SkipError(
        "unsupported-parameter",
        `the parameter "${property}" clashes with an input of the uploader "${name}"`,
      );
    }
    properties[property] = { ...schema };
  }
  required.push(...uploader.required);
  return { mapping: { mode: "upload", uploader: name }, additionalProperties: false };
}

function collectParameters(
  document: OpenApiDocument,
  ...lists: Array<OpenApiOperation["parameters"]>
): OpenApiParameter[] {
  const byKey = new Map<string, OpenApiParameter>();
  for (const list of lists) {
    for (const entry of list ?? []) {
      let parameter: OpenApiParameter;
      try {
        parameter = (
          "$ref" in entry ? lookupPointer(document, entry.$ref) : entry
        ) as OpenApiParameter;
      } catch (error) {
        if (error instanceof UnresolvableReferenceError) {
          throw new SkipError("unresolvable-ref", error.message);
        }
        throw error;
      }
      byKey.set(`${parameter.in}:${parameter.name}`, parameter);
    }
  }
  return [...byKey.values()];
}

/**
 * Adds the body to the input properties: its top-level properties when it is
 * an object whose names clash with no parameter, else the whole body as `body`.
 */
function mergeBody(
  document: OpenApiDocument,
  source: OpenApiOperation,
  properties: Record<string, JsonSchema>,
  required: string[],
): { mapping: BodyMapping; additionalProperties: unknown } {
  const requestBody = source.requestBody;
  if (!requestBody?.content) {
    return { mapping: { mode: "none" }, additionalProperties: false };
  }
  const json = requestBody.content["application/json"];
  if (!json) {
    throw new SkipError("unsupported-body", "the request body has no application/json form");
  }
  const bodyRequired = requestBody.required === true;
  const raw = json.schema ?? {};
  let schema: JsonSchema;
  try {
    schema = "$ref" in raw && typeof raw.$ref === "string" ? dereferenceTop(document, raw) : raw;
  } catch (error) {
    if (error instanceof UnresolvableReferenceError) {
      throw new SkipError("unresolvable-ref", error.message);
    }
    throw error;
  }
  const bodyProperties = schema.properties as Record<string, JsonSchema> | undefined;
  const isObject =
    (schema.type === "object" || (schema.type === undefined && bodyProperties !== undefined)) &&
    schema.oneOf === undefined &&
    schema.anyOf === undefined &&
    schema.allOf === undefined;
  const clashes =
    isObject && Object.keys(bodyProperties ?? {}).some((name) => Object.hasOwn(properties, name));
  if (!isObject || clashes) {
    if (Object.hasOwn(properties, BODY_INPUT)) {
      throw new SkipError(
        "unsupported-parameter",
        `the parameter "${BODY_INPUT}" clashes with the body input`,
      );
    }
    properties[BODY_INPUT] = raw;
    if (bodyRequired) {
      required.push(BODY_INPUT);
    }
    return { mapping: { mode: "wrapped", required: bodyRequired }, additionalProperties: false };
  }
  Object.assign(properties, bodyProperties ?? {});
  if (bodyRequired && Array.isArray(schema.required)) {
    required.push(...(schema.required as string[]));
  }
  const additional = schema.additionalProperties;
  return {
    mapping: { mode: "merged", required: bodyRequired },
    additionalProperties: additional === undefined ? false : additional,
  };
}

/** The schema a top-level `$ref` names, so its properties can be merged. */
function dereferenceTop(document: OpenApiDocument, schema: JsonSchema): JsonSchema {
  const seen = new Set<string>();
  let current = schema;
  while (typeof current.$ref === "string") {
    if (seen.has(current.$ref)) {
      throw new UnresolvableReferenceError(current.$ref);
    }
    seen.add(current.$ref);
    const { $ref: reference, ...siblings } = current;
    const target = lookupPointer(document, reference as string);
    if (target === null || typeof target !== "object") {
      throw new UnresolvableReferenceError(reference as string);
    }
    current = { ...(target as JsonSchema), ...siblings };
  }
  return current;
}
