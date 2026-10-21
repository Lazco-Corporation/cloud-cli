import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { CliError } from "../core/errors";

/** The life of a pending authorization request at the provider. */
export const LOOPBACK_TIMEOUT_MS = 10 * 60 * 1000;

export const CALLBACK_PATH = "/callback";

/*
 * The colours, sizes and shadow are copied by hand from the dark theme in
 * `dist/tokens.css` of `@lazco-corporation/design-system`, and the font stack
 * from its `dist/email.json`. The CLI does not depend on the package for one
 * page, and the page loads no font file, so it uses the system faces the email
 * stack names.
 * The answer can be a denied sign-in, so the page shows no success state.
 */
const DONE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Lazco CLI</title>
<style>
:root{--ground:#08090a;--panel:#101112;--ink:#e8eaec;--ink-2:#c3c8cc;--faint:#858c92;--line:rgba(255,255,255,.07);--brand-fill:#40b7f3;--shadow-2:inset 0 1px 0 0 rgba(255,255,255,.03),inset 0 0 0 1px rgba(255,255,255,.05),0 1px 1px -.5px rgba(0,0,0,.18)}
*{box-sizing:border-box}
html,body{margin:0}
body{min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--ground);color:var(--ink-2);font-family:'Noto Sans TC','PingFang TC','Microsoft JhengHei',-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:26rem;padding:28px;background:var(--panel);border-radius:10px;box-shadow:var(--shadow-2)}
.mark{display:flex;align-items:center;gap:8px;margin:0 0 20px;color:var(--faint);font-size:11.5px;font-weight:600}
.mark::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--brand-fill)}
h1{margin:0 0 6px;color:var(--ink);font-size:24px;line-height:1.25;font-weight:650;letter-spacing:-.01em}
.title{margin:0 0 6px;color:var(--ink);font-size:16px;line-height:1.25;font-weight:600}
p{margin:0}
hr{margin:20px 0;border:0;border-top:1px solid var(--line)}
@media (max-width:640px){h1{font-size:26px}.title{font-size:17px}.mark{font-size:12.5px}}
</style>
</head>
<body>
<main>
<p class="mark">Lazco CLI</p>
<h1>Return to your terminal</h1>
<p>The Lazco CLI got the answer from your browser. You can close this tab.</p>
<hr>
<div lang="zh-Hant-TW">
<p class="title">請回到終端機</p>
<p>Lazco CLI 已經收到瀏覽器的回應，你可以關閉這個分頁。</p>
</div>
</main>
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

/** The URL of a request target, or `undefined` for one that is no URL, such as `//`. */
function requestUrl(target: string | undefined): URL | undefined {
  try {
    return new URL(target ?? "/", "http://loopback");
  } catch {
    return undefined;
  }
}

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
  // A browser can open spare connections that never send a request, and an open
  // socket keeps the process alive after the sign-in, so close() destroys each one.
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const url = requestUrl(request.url);
    if (
      url === undefined ||
      answered ||
      request.method !== "GET" ||
      url.pathname !== CALLBACK_PATH
    ) {
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
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
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
    for (const socket of sockets) {
      socket.destroy();
    }
  };
  return {
    redirectUri,
    close,
    callback: (timeoutMs) =>
      new Promise<URLSearchParams>((resolve, reject) => {
        const timer = setTimeout(() => {
          close();
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
