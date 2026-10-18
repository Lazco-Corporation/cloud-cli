import type { OperationKind } from "../core/generate/annotation";
import type { ApiClient } from "../core/request/client";
import type { JsonSchema } from "../core/spec/types";
import type { Keychain } from "../credentials/keychain";
import type { Session } from "../credentials/session";
import type { GlobalFlags } from "../shell/globalFlags";
import type { Io } from "../shell/io";

export type HandwrittenContext = {
  io: Io;
  flags: GlobalFlags;
  configPath: string;
  keychain: Keychain;
  /** The API and credential source of this run, in the order of `cli-auth`. */
  session(): Promise<Session>;
  /** The credential of the session, which then never reaches any output. */
  credential(): Promise<string>;
  /** A client for one API URL and credential, under the process's one rate cap. */
  client(apiUrl: string, credential: string | undefined): ApiClient;
  /** Keeps a value, such as a token being checked, out of every output. */
  addSecret(value: string): void;
};

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
