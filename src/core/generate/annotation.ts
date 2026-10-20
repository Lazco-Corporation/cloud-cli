import type Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv/dist/2020.js";
import type { JsonSchema } from "../spec/types";

export type OperationKind = "read" | "write" | "destructive" | "spend";

/** The `x-lazco` of an exposed operation, with the keys this version knows. */
export type Annotation = {
  cli: string;
  mcp: { name: string } | false;
  kind: OperationKind;
  feature?: string;
  async?: "task";
  concurrency?: "etag";
  confirm?: string;
  paginate?: "cursor" | "page";
  upload?: string;
  /** The `operationId` of a spend operation's quote operation. */
  quote?: string;
};

/**
 * The input an uploader takes in place of its operation's body. Its
 * positionals follow the operation's path parameters on the command line.
 */
export type UploaderInput = {
  properties: Readonly<Record<string, JsonSchema>>;
  required: readonly string[];
  positionals: readonly string[];
  /** Sentences the MCP tool's description adds, for what the uploader does beyond one request. */
  toolNotes: readonly string[];
};

/** The input `directory`, which the MCP tool takes as an absolute path only. */
export const DIRECTORY_INPUT = "directory";

const PAGES_DEPLOYMENT_INPUT: UploaderInput = {
  properties: {
    [DIRECTORY_INPUT]: {
      type: "string",
      minLength: 1,
      description:
        "The local directory to publish as the site's root. A relative path is resolved against the working directory, and the MCP tool takes an absolute path only. Paths with a segment that starts with a dot, __MACOSX and node_modules are skipped. A link, a zip archive or a single file is refused.",
    },
  },
  required: [DIRECTORY_INPUT],
  positionals: [DIRECTORY_INPUT],
  toolNotes: [
    "Publishes every file of a local directory to the site, which anyone on the internet can read. Only pass a directory the user asked to publish.",
    "directory must be an absolute path. The call checks the limits, uploads the changed files, and waits until the deployment is live or failed, which can take minutes.",
    "When the call ends before the deployment does, the deployment goes on: read it with the deployment read tool.",
  ],
};

/**
 * The uploaders this version has, by the name an operation's `upload` gives.
 * An `upload` naming any other is skipped. `src/uploads/registry.ts` holds
 * the code that runs each one.
 */
export const KNOWN_UPLOADERS: ReadonlyMap<string, UploaderInput> = new Map([
  ["pages-deployment", PAGES_DEPLOYMENT_INPUT],
]);

const COMMAND_WORD = "[a-z0-9][a-z0-9-]*";

/**
 * The shape of the brief, with every key this version reads. A key it does
 * not list is allowed and ignored, so a later key never breaks this version.
 * A known key with an unknown value fails the check.
 */
const ANNOTATION_SCHEMA = {
  type: "object",
  required: ["cli", "mcp", "kind"],
  properties: {
    cli: { type: "string", pattern: `^${COMMAND_WORD}( ${COMMAND_WORD})*$` },
    mcp: {
      oneOf: [
        { const: false },
        {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" } },
        },
      ],
    },
    kind: { enum: ["read", "write", "destructive", "spend"] },
    feature: { type: "string", minLength: 1 },
    async: { enum: ["task"] },
    concurrency: { enum: ["etag"] },
    confirm: { type: "string", minLength: 1 },
    paginate: { enum: ["cursor", "page"] },
    upload: { type: "string", minLength: 1 },
    quote: { type: "string", minLength: 1 },
  },
} as const;

export type AnnotationCheck =
  | { exposed: false }
  | { exposed: true; annotation: Annotation }
  | { exposed: true; problem: string };

export function createAnnotationChecker(ajv: Ajv2020): (value: unknown) => AnnotationCheck {
  const validate = ajv.compile(ANNOTATION_SCHEMA);
  return (value) => {
    if (
      value !== null &&
      typeof value === "object" &&
      (value as { expose?: unknown }).expose === false
    ) {
      return { exposed: false };
    }
    if (value === undefined) {
      return { exposed: true, problem: "the operation has no x-lazco" };
    }
    if (!validate(value)) {
      return { exposed: true, problem: describeProblems(validate.errors ?? []) };
    }
    return { exposed: true, annotation: value as Annotation };
  };
}

function describeProblems(errors: readonly ErrorObject[]): string {
  const first = errors.find((error) => error.keyword !== "oneOf") ?? errors[0];
  if (!first) {
    return "x-lazco is not valid";
  }
  const at = first.instancePath ? `x-lazco${first.instancePath.replaceAll("/", ".")}` : "x-lazco";
  const allowed =
    first.keyword === "enum"
      ? ` (${(first.params as { allowedValues: unknown[] }).allowedValues.join(", ")})`
      : "";
  return `${at} ${first.message ?? "is not valid"}${allowed}`;
}
