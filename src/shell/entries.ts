import type { HandwrittenCommand } from "../commands/types";
import type { OperationKind } from "../core/generate/annotation";
import type { Operation } from "../core/generate/operations";
import type { JsonSchema } from "../core/spec/types";

/** One command of the shell, generated from an operation or written by hand. */
export type CommandEntry = {
  command: readonly string[];
  summary: string;
  description: string;
  kind: OperationKind;
  feature: string | null;
  inputSchema: JsonSchema;
  positionals: readonly string[];
  source:
    | { type: "operation"; operation: Operation }
    | { type: "handwritten"; handwritten: HandwrittenCommand };
};

export function operationEntry(operation: Operation): CommandEntry {
  return {
    command: operation.command,
    summary: operation.summary,
    description: operation.description,
    kind: operation.kind,
    feature: operation.feature,
    inputSchema: operation.commandInputSchema,
    positionals: operation.positionals,
    source: { type: "operation", operation },
  };
}

export function handwrittenEntry(handwritten: HandwrittenCommand): CommandEntry {
  return {
    command: handwritten.command,
    summary: handwritten.summary,
    description: handwritten.description ?? "",
    kind: handwritten.kind,
    feature: null,
    inputSchema: handwritten.inputSchema,
    positionals: handwritten.positionals,
    source: { type: "handwritten", handwritten },
  };
}
