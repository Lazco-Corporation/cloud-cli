import type { Clock } from "../../src/core/request/clock";

export type RecordedRequest = {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: unknown;
  at: number;
};

export type FakeHandler = (request: RecordedRequest) => Response | Promise<Response>;

/** An API on 127.0.0.1 that records every request and answers with a handler. */
export class FakeApi {
  readonly requests: RecordedRequest[] = [];
  handler: FakeHandler;
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(handler: FakeHandler = () => json(404, { error: "Not found", code: "NOT_FOUND" })) {
    this.handler = handler;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const text = await request.text();
        const isForm = (request.headers.get("content-type") ?? "").startsWith(
          "application/x-www-form-urlencoded",
        );
        const recorded: RecordedRequest = {
          method: request.method,
          path: url.pathname,
          search: url.search,
          headers: Object.fromEntries(request.headers.entries()),
          body: !text
            ? undefined
            : isForm
              ? Object.fromEntries(new URLSearchParams(text))
              : JSON.parse(text),
          at: Date.now(),
        };
        this.requests.push(recorded);
        return this.handler(recorded);
      },
    });
  }

  /** The base URL with `/v1`, as `--api-url` takes it. */
  get apiUrl(): string {
    return `${this.origin}/v1`;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A clock whose sleep returns at once and moves time forward, recording each wait. */
export function fakeClock(start = 1_000_000): Clock & { sleeps: number[]; time: number } {
  const clock = {
    time: start,
    sleeps: [] as number[],
    now: () => clock.time,
    sleep: async (milliseconds: number) => {
      clock.sleeps.push(milliseconds);
      clock.time += milliseconds;
    },
  };
  return clock;
}

/** A URL on 127.0.0.1 where nothing listens. */
export async function closedApiUrl(): Promise<string> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const url = `http://127.0.0.1:${server.port}/v1`;
  server.stop(true);
  return url;
}
