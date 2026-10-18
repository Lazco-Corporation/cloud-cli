import type Ajv2020 from "ajv/dist/2020";
import type { ErrorObject } from "ajv/dist/2020";

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
};

/** The uploaders this version has. An `upload` naming any other is skipped. */
export const KNOWN_UPLOADERS: ReadonlySet<string> = new Set();

const COMMAND_WORD = "[a-z0-9][a-z0-9-]*";

/**
 * The shape of the brief, with every key this version reads. A key it does
 * not list is allowed and ignored, so a later key such as `quote` never breaks
 * this version. A known key with an unknown value fails the check.
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
