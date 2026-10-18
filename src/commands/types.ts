import type Ajv2020 from "ajv/dist/2020.js";
import type { PathEnvironment } from "../config/paths";
import type { OperationKind } from "../core/generate/annotation";
import type { ApiClient } from "../core/request/client";
import type { Clock } from "../core/request/clock";
import type { InputValidator } from "../core/request/validate";
import type { JsonSchema } from "../core/spec/types";
import type { Keychain } from "../credentials/keychain";
import type { Session } from "../credentials/session";
import type { GlobalFlags } from "../shell/globalFlags";
import type { Io } from "../shell/io";

export type HandwrittenContext = {
  io: Io;
  flags: GlobalFlags;
  configPath: string;
  /** The `lazco` cache root. */
  cacheDirectory: string;
  /** The environment, platform and home directory that paths are made from. */
  paths: PathEnvironment;
  keychain: Keychain;
  version: string;
  clock: Clock;
  ajv: Ajv2020;
  validator: InputValidator;
  /** The API and credential source of this run, in the order of `cli-auth`. */
  session(): Promise<Session>;
  /** The credential of the session, which then never reaches any output. */
  credential(): Promise<string>;
  /**
   * A client for one API URL and credential, under the process's one rate
   * cap, with the CLI's `User-Agent` unless another is given.
   */
  client(
    apiUrl: string,
    credential: string | undefined,
    userAgent?: string | (() => string),
  ): ApiClient;
  /** Keeps a value, such as a token being checked, out of every output. */
  addSecret(value: string): void;
};

/**
 * What a hand-written command prints: one record, a list as NDJSON, or
 * nothing, for a command that owns stdout itself, as `lazco mcp` does.
 */
export type HandwrittenResult =
  | { record: unknown }
  | { list: readonly unknown[] }
  | { silent: true };

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
