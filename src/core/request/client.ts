import type { Credential } from "../../credentials/credential";
import { ApiError, CliError, redactSecrets, toToolError } from "../errors";
import { type Clock, SYSTEM_CLOCK } from "./clock";
import { isReplayed } from "./idempotency";
import type { RateLimiter } from "./rateLimiter";

export const REQUEST_TIMEOUT_MS = 60_000;
/** Tries of a GET in all. */
export const MAX_ATTEMPTS = 3;
/** Tries in all of a request with `Idempotency-Key`. */
export const MAX_KEYED_ATTEMPTS = 5;
export const MAX_RETRY_AFTER_SECONDS = 60;
const GET_BACKOFF_MS = [500, 1000];
const KEYED_BACKOFF_MS = [1000, 2000, 4000, 8000];
const GET_RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const GATEWAY_STATUSES = new Set([502, 503, 504]);
/** The API's answer while the first request with the same key still runs. */
const KEY_IN_PROGRESS = "IDEMPOTENCY_KEY_IN_PROGRESS";

export type ApiRequest = {
  method: string;
  /** The path below the API URL, already encoded, starting with `/`. */
  path: string;
  query?: ReadonlyArray<readonly [string, string]>;
  headers?: Record<string, string>;
  /** A JSON body. `undefined` sends none. */
  body?: unknown;
  /** A form body (`application/x-www-form-urlencoded`), as an OAuth endpoint takes. Never with `body`. */
  form?: Record<string, string>;
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
  credential?: Credential;
  /** The `User-Agent`, or a function read on each request when it can change, as in MCP. */
  userAgent: string | (() => string);
  limiter: RateLimiter;
  fetch?: typeof fetch;
  clock?: Clock;
  random?: () => number;
  timeoutMs?: number;
  /**
   * Called with the key when the API answers a keyed request with the stored
   * first result of that key (`Idempotent-Replayed: true`), success or error.
   */
  onReplay?: (idempotencyKey: string) => void;
};

/** A request with this header may be repeated safely, as a GET may. */
const IDEMPOTENCY_HEADER = "idempotency-key";

/**
 * Which requests are sent again: a GET, and a request with `Idempotency-Key`,
 * whose retry the API answers with the first result instead of running it again.
 */
type RetryPolicy = "get" | "keyed" | "once";

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
  publicHeaders(request: Pick<ApiRequest, "headers" | "body" | "form">): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent":
        typeof this.options.userAgent === "string"
          ? this.options.userAgent
          : this.options.userAgent(),
    };
    if (request.form !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (request.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    return { ...headers, ...request.headers };
  }

  /**
   * Sends a request with the rate cap, the timeout and the retries, and returns
   * the answer whatever its status. A 401 to an SSO access token refreshes it
   * once and sends the request once more. Throws `CLI_NETWORK`, `CLI_TIMEOUT`
   * or `CLI_BAD_RESPONSE`, and for an SSO credential whatever its refresh
   * throws, such as `CLI_NOT_LOGGED_IN`.
   */
  async send(request: ApiRequest): Promise<ApiResponse> {
    if (request.form !== undefined && request.body !== undefined) {
      throw new CliError("CLI_INTERNAL", "A request has both a JSON body and a form body");
    }
    try {
      const credential = request.authenticate === false ? undefined : this.options.credential;
      const bearer = await credential?.bearer();
      let response = await this.sendWithRetries(request, bearer);
      if (response.status === 401 && credential !== undefined && bearer !== undefined) {
        const renewed = await credential.renewAfterUnauthorized(bearer);
        if (renewed !== undefined) {
          response = await this.sendWithRetries(request, renewed);
        }
      }
      this.noticeReplay(request, response);
      return response;
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

  private noticeReplay(request: ApiRequest, response: ApiResponse): void {
    if (this.options.onReplay === undefined || !isReplayed(response.headers)) {
      return;
    }
    const key = Object.entries(request.headers ?? {}).find(
      ([name]) => name.toLowerCase() === IDEMPOTENCY_HEADER,
    )?.[1];
    if (key !== undefined) {
      this.options.onReplay(key);
    }
  }

  private redact<T>(error: T): T {
    const secrets = this.options.credential?.secrets() ?? [];
    if (secrets.length === 0) {
      return error;
    }
    if (error instanceof ApiError) {
      const body = redactSecrets(error.toBody(), secrets);
      const { status, code, message, ...fields } = body;
      return new ApiError(status as number, code, message, fields) as T;
    }
    if (error instanceof CliError) {
      return new CliError(
        error.code,
        redactSecrets(error.message, secrets),
        redactSecrets(error.details, secrets),
      ) as T;
    }
    return error;
  }

  private retryPolicy(request: ApiRequest): RetryPolicy {
    if (request.method.toUpperCase() === "GET") {
      return "get";
    }
    const keyed = Object.keys(request.headers ?? {}).some(
      (name) => name.toLowerCase() === IDEMPOTENCY_HEADER,
    );
    return keyed ? "keyed" : "once";
  }

  private async sendWithRetries(
    request: ApiRequest,
    bearer: string | undefined,
  ): Promise<ApiResponse> {
    const policy = this.retryPolicy(request);
    const maxAttempts =
      policy === "get" ? MAX_ATTEMPTS : policy === "keyed" ? MAX_KEYED_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt += 1) {
      const lastAttempt = attempt >= maxAttempts;
      let response: ApiResponse;
      try {
        response = await this.sendOnce(request, bearer);
      } catch (error) {
        // A timeout is never sent again: the request may still run, and the wait was already long.
        if (lastAttempt || !(error instanceof CliError) || error.code !== "CLI_NETWORK") {
          throw error;
        }
        await this.clock.sleep(this.backoffMs(policy, attempt));
        continue;
      }
      if (lastAttempt || !isRetryableAnswer(policy, response)) {
        return response;
      }
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.clock.now());
      if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_SECONDS) {
        return response;
      }
      await this.clock.sleep(
        retryAfter === undefined ? this.backoffMs(policy, attempt) : retryAfter * 1000,
      );
    }
  }

  /**
   * A GET waits about 0.5 s, then 1 s, with 25% jitter either way. A keyed
   * request waits 1, 2, 4, then 8 s.
   */
  private backoffMs(policy: RetryPolicy, attempt: number): number {
    if (policy === "keyed") {
      return KEYED_BACKOFF_MS[Math.min(attempt, KEYED_BACKOFF_MS.length) - 1] ?? 8000;
    }
    const base = GET_BACKOFF_MS[Math.min(attempt, GET_BACKOFF_MS.length) - 1] ?? 1000;
    return base * (0.75 + this.random() * 0.5);
  }

  private async sendOnce(request: ApiRequest, bearer: string | undefined): Promise<ApiResponse> {
    await this.options.limiter.acquire();
    const headers = this.publicHeaders(request);
    if (bearer !== undefined) {
      headers.Authorization = `Bearer ${bearer}`;
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
        body:
          request.form !== undefined
            ? new URLSearchParams(request.form).toString()
            : request.body === undefined
              ? undefined
              : JSON.stringify(request.body),
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

/**
 * Whether an answer is worth the same request again. A keyed request is sent
 * again only where the API cannot have stored an answer under the key: a 429,
 * a 502, 503 or 504 from something in front of the API (not our error shape),
 * and the key's first request still running.
 */
function isRetryableAnswer(policy: RetryPolicy, response: ApiResponse): boolean {
  if (policy === "get") {
    return GET_RETRYABLE_STATUSES.has(response.status);
  }
  if (policy === "once") {
    return false;
  }
  if (response.status === 429) {
    return true;
  }
  if (GATEWAY_STATUSES.has(response.status)) {
    return !hasApiErrorShape(response.body);
  }
  return (
    response.status === 409 &&
    hasApiErrorShape(response.body) &&
    response.body.code === KEY_IN_PROGRESS
  );
}

/** JSON with a string `code`, the shape of every error the API itself answers. */
function hasApiErrorShape(body: unknown): body is Record<string, unknown> & { code: string } {
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    !(body instanceof NotJson) &&
    typeof (body as { code?: unknown }).code === "string"
  );
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
  if (!hasApiErrorShape(body)) {
    return new CliError("CLI_BAD_RESPONSE", "The API answered with an unexpected body", {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
    });
  }
  const { code, error, message, ...fields } = body;
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
