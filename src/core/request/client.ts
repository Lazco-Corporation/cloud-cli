import { ApiError, CliError, redactSecrets, toToolError } from "../errors";
import { type Clock, SYSTEM_CLOCK } from "./clock";
import type { RateLimiter } from "./rateLimiter";

export const REQUEST_TIMEOUT_MS = 60_000;
export const MAX_ATTEMPTS = 3;
export const MAX_RETRY_AFTER_SECONDS = 60;
const BACKOFF_BASE_MS = [500, 1000];
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

export type ApiRequest = {
  method: string;
  /** The path below the API URL, already encoded, starting with `/`. */
  path: string;
  query?: ReadonlyArray<readonly [string, string]>;
  headers?: Record<string, string>;
  /** A JSON body. `undefined` sends none. */
  body?: unknown;
  /** `false` sends no credential, as for `GET /spec`. */
  authenticate?: boolean;
};

export type ApiResponse = {
  status: number;
  headers: Headers;
  body: unknown;
};

export type ClientOptions = {
  /** The API base URL, such as `https://api.lazco.tw/v1`, without a trailing slash. */
  apiUrl: string;
  credential?: string;
  userAgent: string;
  limiter: RateLimiter;
  fetch?: typeof fetch;
  clock?: Clock;
  random?: () => number;
  timeoutMs?: number;
};

/** A request with this header may be repeated safely, as a GET may. */
const IDEMPOTENCY_HEADER = "idempotency-key";

export class ApiClient {
  readonly apiUrl: string;
  private readonly options: ClientOptions;
  private readonly fetchImplementation: typeof fetch;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.options = options;
    this.apiUrl = options.apiUrl;
    this.fetchImplementation = options.fetch ?? fetch;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  get hasCredential(): boolean {
    return Boolean(this.options.credential);
  }

  /** The URL a request goes to. */
  url(request: Pick<ApiRequest, "path" | "query">): string {
    const search = new URLSearchParams();
    for (const [name, value] of request.query ?? []) {
      search.append(name, value);
    }
    const query = search.toString();
    return `${this.apiUrl}${request.path}${query ? `?${query}` : ""}`;
  }

  /** The headers a request carries, without the credential. */
  publicHeaders(request: Pick<ApiRequest, "headers" | "body">): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.options.userAgent,
    };
    if (request.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    return { ...headers, ...request.headers };
  }

  /**
   * Sends a request with the rate cap, the timeout and the retries, and returns
   * the answer whatever its status. Throws only `CLI_NETWORK`, `CLI_TIMEOUT` or
   * `CLI_BAD_RESPONSE`.
   */
  async send(request: ApiRequest): Promise<ApiResponse> {
    try {
      return await this.sendWithRetries(request);
    } catch (error) {
      throw this.redact(toToolError(error));
    }
  }

  /** Sends a request and throws the mapped error for any answer that is not 2xx. */
  async call(request: ApiRequest): Promise<ApiResponse> {
    const response = await this.send(request);
    if (response.status >= 200 && response.status < 300) {
      return response;
    }
    throw this.redact(mapErrorResponse(response));
  }

  private redact<T>(error: T): T {
    const credential = this.options.credential;
    if (!credential) {
      return error;
    }
    if (error instanceof ApiError) {
      const body = redactSecrets(error.toBody(), [credential]);
      const { status, code, message, ...fields } = body;
      return new ApiError(status as number, code, message, fields) as T;
    }
    if (error instanceof CliError) {
      return new CliError(
        error.code,
        redactSecrets(error.message, [credential]),
        redactSecrets(error.details, [credential]),
      ) as T;
    }
    return error;
  }

  private isRetryable(request: ApiRequest): boolean {
    if (request.method.toUpperCase() === "GET") {
      return true;
    }
    return Object.keys(request.headers ?? {}).some(
      (name) => name.toLowerCase() === IDEMPOTENCY_HEADER,
    );
  }

  private async sendWithRetries(request: ApiRequest): Promise<ApiResponse> {
    const retryable = this.isRetryable(request);
    for (let attempt = 1; ; attempt += 1) {
      const lastAttempt = !retryable || attempt >= MAX_ATTEMPTS;
      let response: ApiResponse;
      try {
        response = await this.sendOnce(request);
      } catch (error) {
        if (lastAttempt || !(error instanceof CliError) || error.code !== "CLI_NETWORK") {
          throw error;
        }
        await this.clock.sleep(this.backoffMs(attempt));
        continue;
      }
      if (lastAttempt || !RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }
      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.clock.now());
        if (retryAfter !== undefined) {
          if (retryAfter > MAX_RETRY_AFTER_SECONDS) {
            return response;
          }
          await this.clock.sleep(retryAfter * 1000);
          continue;
        }
      }
      await this.clock.sleep(this.backoffMs(attempt));
    }
  }

  /** About 0.5 s after the first try and 1 s after the second, with 25% jitter either way. */
  private backoffMs(attempt: number): number {
    const base = BACKOFF_BASE_MS[Math.min(attempt, BACKOFF_BASE_MS.length) - 1] ?? 1000;
    return base * (0.75 + this.random() * 0.5);
  }

  private async sendOnce(request: ApiRequest): Promise<ApiResponse> {
    await this.options.limiter.acquire();
    const headers = this.publicHeaders(request);
    if (request.authenticate !== false && this.options.credential) {
      headers.Authorization = `Bearer ${this.options.credential}`;
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const url = this.url(request);
    try {
      const response = await this.fetchImplementation(url, {
        method: request.method.toUpperCase(),
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: "manual",
        signal: controller.signal,
      });
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        body: parseBody(response, text),
      };
    } catch (error) {
      if (timedOut) {
        throw new CliError("CLI_TIMEOUT", `No answer within ${this.timeoutMs / 1000} seconds`, {
          method: request.method.toUpperCase(),
          url,
        });
      }
      if (error instanceof CliError) {
        throw error;
      }
      throw new CliError("CLI_NETWORK", "The API could not be reached", {
        url,
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The JSON of a body, `null` for an empty one, or a marker for a body that is not JSON. */
function parseBody(response: Response, text: string): unknown {
  if (text.length === 0) {
    return null;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/[/+]json\b/i.test(contentType)) {
    return new NotJson(contentType, text);
  }
  try {
    return JSON.parse(text);
  } catch {
    return new NotJson(contentType, text);
  }
}

/** A body that is not JSON, kept so the error can name its content type. */
export class NotJson {
  readonly contentType: string;
  readonly text: string;

  constructor(contentType: string, text: string) {
    this.contentType = contentType;
    this.text = text;
  }
}

/** `CLI_BAD_RESPONSE` unless the body of a 2xx answer is JSON or empty. */
export function requireJson(response: ApiResponse): unknown {
  if (response.body instanceof NotJson) {
    throw new CliError("CLI_BAD_RESPONSE", "The API answered with a body that is not JSON", {
      status: response.status,
      contentType: response.body.contentType,
    });
  }
  return response.body;
}

/**
 * An answer of the API's error shape (JSON with a string `code`) passes through
 * with its status and every field. `message` is the body's own `message` when it
 * has one, which is the specific text, and the generic `error` text otherwise.
 */
export function mapErrorResponse(response: ApiResponse): ApiError | CliError {
  const body = response.body;
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body instanceof NotJson ||
    typeof (body as { code?: unknown }).code !== "string"
  ) {
    return new CliError("CLI_BAD_RESPONSE", "The API answered with an unexpected body", {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
    });
  }
  const { code, error, message, ...fields } = body as Record<string, unknown>;
  const text =
    typeof message === "string"
      ? message
      : typeof error === "string"
        ? error
        : `HTTP ${response.status}`;
  return new ApiError(response.status, code as string, text, fields);
}

/** Seconds to wait from a `Retry-After` header, in either of its two forms. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, Math.ceil((date - now) / 1000));
}
