import type { CommandEntry } from "./entries";
import { flagSpecs } from "./input";

/** `lazco <command> --describe`: the command, its operation and the JSON Schema of its input. */
export function describeEntry(entry: CommandEntry): Record<string, unknown> {
  const operation = entry.source.type === "operation" ? entry.source.operation : undefined;
  const flags = Object.fromEntries(
    flagSpecs(entry.inputSchema, entry.positionals).map((spec) => [
      `--${spec.flag}`,
      spec.property,
    ]),
  );
  return {
    command: entry.command.join(" "),
    summary: entry.summary,
    description: entry.description,
    operationId: operation?.operationId ?? null,
    method: operation ? operation.method.toUpperCase() : null,
    path: operation?.path ?? null,
    kind: entry.kind,
    async: operation?.annotation.async ?? null,
    concurrency: operation?.annotation.concurrency ?? null,
    paginate: operation?.annotation.paginate ?? null,
    confirm: operation?.annotation.confirm ?? null,
    upload: operation?.annotation.upload ?? null,
    // How the operation takes Idempotency-Key. The core sends it, so it is no input field.
    idempotencyKey: operation?.idempotencyKey ?? null,
    feature: entry.feature,
    mcpTool: operation?.toolName ?? null,
    positionals: entry.positionals,
    flags,
    inputSchema: entry.inputSchema,
  };
}

/** One line of `lazco --describe`. */
export function summarizeEntry(entry: CommandEntry): Record<string, unknown> {
  return { command: entry.command.join(" "), summary: entry.summary, kind: entry.kind };
}
