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
  /**
   * The body properties the uploader can build from its own input. With it,
   * every top-level body property stays an input and is sent as given, and
   * these lose their `required`, because the uploader fills them when the
   * input does not. Without it, the uploader's input replaces the whole body.
   */
  fills?: readonly string[];
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

/** The input `path` of the artifact uploader: a local file or directory. */
export const ARTIFACT_PATH_INPUT = "path";
/** The body property the artifact uploader builds from `path`. */
export const ARTIFACT_FILES_INPUT = "files";

const ARTIFACT_INPUT: UploaderInput = {
  properties: {
    [ARTIFACT_PATH_INPUT]: {
      type: "string",
      minLength: 1,
      description:
        "The local file or directory to publish, in place of files. A directory is read with every file below it, and every file or directory whose name starts with a dot is skipped. A relative path is resolved against the working directory, and the MCP tool takes an absolute path only.",
    },
  },
  required: [],
  positionals: [ARTIFACT_PATH_INPUT],
  toolNotes: [
    "Publishes content that anyone with the link can open. Only publish what the user asked to publish.",
    "Give either path, an absolute path of a local file or directory, or files, for content that is not in a file, such as one Markdown or HTML document. Never both.",
    "The answer holds url, the permanent link, and warnings: what the page loads from outside, misses or runs, which will not work.",
  ],
  fills: [ARTIFACT_FILES_INPUT],
};

/**
 * The uploaders this version has, by the name an operation's `upload` gives.
 * An `upload` naming any other is skipped. `src/uploads/registry.ts` holds
 * the code that runs each one.
 */
export const KNOWN_UPLOADERS: ReadonlyMap<string, UploaderInput> = new Map([
  ["pages-deployment", PAGES_DEPLOYMENT_INPUT],
  ["artifact", ARTIFACT_INPUT],
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
