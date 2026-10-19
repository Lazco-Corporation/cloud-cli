import { createServer, type Server, type Socket } from "node:net";

export type RawRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
};

/** What the server does with one request: drop the connection, or answer it. */
export type RawAnswer =
  | "drop"
  | { status: number; body: unknown; headers?: Record<string, string> };

/**
 * An API on 127.0.0.1 over plain TCP, so a test can drop a connection after
 * the whole request arrived and before any answer, as a cut network does.
 * `Bun.serve` cannot: a handler that throws still answers 500.
 */
export class DroppingApi {
  readonly requests: RawRequest[] = [];
  handler: (request: RawRequest, index: number) => RawAnswer;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private port = 0;

  private constructor(handler: (request: RawRequest, index: number) => RawAnswer) {
    this.handler = handler;
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const parsed = parseRequest(buffer);
          if (parsed === undefined) {
            return;
          }
          buffer = buffer.subarray(parsed.length);
          const index = this.requests.length;
          this.requests.push(parsed.request);
          const answer = this.handler(parsed.request, index);
          if (answer === "drop") {
            socket.destroy();
            return;
          }
          const text = JSON.stringify(answer.body);
          const headers = {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(text)),
            ...answer.headers,
          };
          socket.write(
            `HTTP/1.1 ${answer.status} X\r\n${Object.entries(headers)
              .map(([name, value]) => `${name}: ${value}\r\n`)
              .join("")}\r\n${text}`,
          );
        }
      });
    });
  }

  static async start(
    handler: (request: RawRequest, index: number) => RawAnswer,
  ): Promise<DroppingApi> {
    const api = new DroppingApi(handler);
    await new Promise<void>((resolve) => api.server.listen(0, "127.0.0.1", resolve));
    const address = api.server.address();
    api.port = typeof address === "object" && address !== null ? address.port : 0;
    return api;
  }

  /** The base URL with `/v1`, as `--api-url` takes it. */
  get apiUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function parseRequest(buffer: Buffer): { request: RawRequest; length: number } | undefined {
  const end = buffer.indexOf("\r\n\r\n");
  if (end === -1) {
    return undefined;
  }
  const [requestLine = "", ...lines] = buffer.subarray(0, end).toString("latin1").split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const length = Number(headers["content-length"] ?? "0");
  if (buffer.length < end + 4 + length) {
    return undefined;
  }
  const text = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
  const [method = "", path = ""] = requestLine.split(" ");
  return {
    request: { method, path, headers, body: text ? JSON.parse(text) : undefined },
    length: end + 4 + length,
  };
}
