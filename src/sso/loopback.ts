import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CliError } from "../core/errors";

/** The life of a pending authorization request at the provider. */
export const LOOPBACK_TIMEOUT_MS = 10 * 60 * 1000;

export const CALLBACK_PATH = "/callback";

const DONE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Lazco CLI</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 32rem; line-height: 1.6">
<h1 style="font-size: 1.25rem">Return to your terminal</h1>
<p>The Lazco CLI got the answer of your browser. You can close this tab.</p>
<p lang="zh-Hant-TW">請回到終端機。Lazco CLI 已經收到瀏覽器的回應，你可以關閉這個分頁。</p>
</body>
</html>
`;

/** A listener on the loopback address that takes the one redirect of a sign-in. */
export type LoopbackListener = {
  /** `http://127.0.0.1:<port>/callback`, or `http://[::1]:<port>/callback`. */
  redirectUri: string;
  /**
   * The query of the first `GET /callback`. Fails with `CLI_TIMEOUT` after
   * `timeoutMs`. The listener stops after either.
   */
  callback(timeoutMs: number): Promise<URLSearchParams>;
  close(): void;
};

function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    // Port 0: the operating system picks a free port, so no other program can hold it first.
    server.listen(0, host);
  });
}

/**
 * The addresses a listener tries, in order: IPv4 loopback, then IPv6
 * loopback. Never the name `localhost`, which a resolver may send elsewhere.
 */
export const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "::1"];

/** The host of a URL for an address, with the brackets of an IPv6 literal. */
function urlHost(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

/** Listens on the first address of `hosts` that the system lets it bind. */
export async function startLoopback(
  hosts: readonly string[] = LOOPBACK_HOSTS,
): Promise<LoopbackListener> {
  let settle: ((query: URLSearchParams) => void) | undefined;
  let received: URLSearchParams | undefined;
  let answered = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://loopback");
    if (answered || request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      response.end("Not found\n");
      return;
    }
    answered = true;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      connection: "close",
    });
    response.end(DONE_PAGE, () => {
      received = url.searchParams;
      settle?.(received);
    });
  });
  let redirectUri: string | undefined;
  let lastError: unknown;
  for (const host of hosts) {
    try {
      redirectUri = `http://${urlHost(host)}:${await listen(server, host)}${CALLBACK_PATH}`;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (redirectUri === undefined) {
    throw new CliError(
      "CLI_INTERNAL",
      `No loopback address could be listened on for the browser sign-in: ${(lastError as Error | undefined)?.message ?? "none to try"}. Sign in with --device instead`,
    );
  }
  const close = () => {
    server.close();
    server.closeIdleConnections();
  };
  return {
    redirectUri,
    close,
    callback: (timeoutMs) =>
      new Promise<URLSearchParams>((resolve, reject) => {
        const timer = setTimeout(() => {
          server.close();
          server.closeAllConnections();
          reject(
            new CliError(
              "CLI_TIMEOUT",
              `The browser sign-in did not come back within ${Math.round(timeoutMs / 60_000)} minutes`,
            ),
          );
        }, timeoutMs);
        settle = (query) => {
          clearTimeout(timer);
          close();
          resolve(query);
        };
        if (received !== undefined) {
          settle(received);
        }
      }),
  };
}
