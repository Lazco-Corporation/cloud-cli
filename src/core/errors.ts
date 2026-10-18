/**
 * The codes of errors that the tool makes itself. They are a public contract:
 * adding, renaming or removing one is a semver change of the tool.
 */
export const CLI_ERROR_CODES = [
  "CLI_INVALID_INPUT",
  "CLI_NOT_LOGGED_IN",
  "CLI_CONFIRM_REQUIRED",
  "CLI_NETWORK",
  "CLI_BAD_RESPONSE",
  "CLI_SPEC_UNAVAILABLE",
  "CLI_TIMEOUT",
  "CLI_TASK_FAILED",
  "CLI_INTERNAL",
] as const;

export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

/** The `error` member of the one error line the tool writes. */
export type ErrorBody = { [field: string]: unknown; code: string; message: string };

/** An error the tool made itself. It carries no HTTP status. */
export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly details: unknown;

  constructor(code: CliErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }

  toBody(): ErrorBody {
    const body: ErrorBody = { code: this.code, message: this.message };
    if (this.details !== undefined) {
      body.details = this.details;
    }
    return body;
  }
}

/** An error answer of the API, passed through with its status and every field. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, unknown>;

  constructor(status: number, code: string, message: string, fields: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }

  toBody(): ErrorBody {
    return { status: this.status, code: this.code, message: this.message, ...this.fields };
  }
}

export type ToolError = CliError | ApiError;

/** Any thrown value as an error of the tool's shape. */
export function toToolError(error: unknown): ToolError {
  if (error instanceof CliError || error instanceof ApiError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CliError("CLI_INTERNAL", message);
}

/**
 * Replaces every occurrence of each secret in every string of a value, keys
 * included, so a credential echoed by a server or a proxy never reaches output.
 */
export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  const active = secrets.filter((secret) => secret.length > 0);
  if (active.length === 0) {
    return value;
  }
  const scrub = (text: string): string =>
    active.reduce((current, secret) => current.split(secret).join("[REDACTED]"), text);
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return scrub(node);
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([key, child]) => [scrub(key), walk(child)]),
      );
    }
    return node;
  };
  return walk(value) as T;
}
