import type { OperationKind } from "../core/generate/annotation";
import type { JsonSchema } from "../core/spec/types";
import type { GlobalFlags } from "../shell/globalFlags";
import type { Io } from "../shell/io";

export type HandwrittenContext = { io: Io; flags: GlobalFlags };

/** What a hand-written command prints: one record, or a list as NDJSON. */
export type HandwrittenResult = { record: unknown } | { list: readonly unknown[] };

/**
 * A command that wraps no API operation: sign-in, profiles and credentials,
 * uploads, and the MCP server. Its flags are described as JSON Schema too, so
 * `--describe` and the flag parser treat it like a generated command.
 */
export type HandwrittenCommand = {
  command: readonly string[];
  summary: string;
  description?: string;
  kind: OperationKind;
  inputSchema: JsonSchema;
  positionals: readonly string[];
  run(input: Record<string, unknown>, context: HandwrittenContext): Promise<HandwrittenResult>;
};
