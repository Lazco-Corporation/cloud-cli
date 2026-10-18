import type Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import { CliError } from "../errors";
import type { JsonSchema } from "../spec/types";
import type { InputProblem } from "./guard";

/** Checks an input object against the spec's own JSON Schema, compiled once per schema. */
export class InputValidator {
  private readonly ajv: Ajv2020;
  private readonly compiled = new WeakMap<JsonSchema, ValidateFunction>();

  constructor(ajv: Ajv2020) {
    this.ajv = ajv;
  }

  /** Throws `CLI_INVALID_INPUT` listing every problem. */
  check(schema: JsonSchema, input: unknown): void {
    let validate = this.compiled.get(schema);
    if (!validate) {
      validate = this.ajv.compile(schema);
      this.compiled.set(schema, validate);
    }
    if (!validate(input)) {
      throw new CliError(
        "CLI_INVALID_INPUT",
        "The input does not match the command's schema",
        describeErrors(validate.errors ?? []),
      );
    }
  }
}

/** A JSON pointer such as `/cloudInit/sshKeys/0` as `cloudInit.sshKeys[0]`. */
function fieldName(pointer: string, child?: string): string {
  const segments = pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (child !== undefined) {
    segments.push(child);
  }
  return segments.reduce(
    (name, segment) =>
      /^\d+$/.test(segment) ? `${name}[${segment}]` : name ? `${name}.${segment}` : segment,
    "",
  );
}

function describeErrors(errors: readonly ErrorObject[]): InputProblem[] {
  const problems: InputProblem[] = [];
  const seen = new Set<string>();
  for (const error of errors) {
    let problem: InputProblem;
    if (error.keyword === "required") {
      const missing = (error.params as { missingProperty: string }).missingProperty;
      problem = { field: fieldName(error.instancePath, missing), message: "is required" };
    } else if (error.keyword === "additionalProperties") {
      const extra = (error.params as { additionalProperty: string }).additionalProperty;
      problem = {
        field: fieldName(error.instancePath, extra),
        message: "is not an input of this command",
      };
    } else {
      const allowed =
        error.keyword === "enum"
          ? `: ${(error.params as { allowedValues: unknown[] }).allowedValues.map((value) => JSON.stringify(value)).join(", ")}`
          : "";
      problem = {
        field: fieldName(error.instancePath),
        message: `${error.message ?? "is not valid"}${allowed}`,
      };
    }
    const key = `${problem.field}\u0000${problem.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      problems.push(problem);
    }
  }
  return problems;
}
