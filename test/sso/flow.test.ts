import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { connect } from "node:net";
import { CliError } from "../../src/core/errors";
import { startLoopback } from "../../src/sso/loopback";
import { usesDeviceFlow } from "../../src/sso/signIn";

/** True when this host can listen on `::1`, which the fallback test needs. */
const IPV6_LOOPBACK = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

describe("the choice of flow", () => {
  const cases: Array<[string, Record<string, string>, NodeJS.Platform, boolean, boolean]> = [
    ["--device", {}, "darwin", true, true],
    ["SSH_CONNECTION", { SSH_CONNECTION: "192.0.2.1 1 192.0.2.2 22" }, "darwin", false, true],
    ["Linux without a display", {}, "linux", false, true],
    ["Linux with DISPLAY", { DISPLAY: ":0" }, "linux", false, false],
    ["Linux with WAYLAND_DISPLAY", { WAYLAND_DISPLAY: "wayland-0" }, "linux", false, false],
    ["a Mac", {}, "darwin", false, false],
    ["Windows", {}, "win32", false, false],
  ];
  for (const [label, env, platform, device, expected] of cases) {
    test(`${label}: ${expected ? "device" : "loopback"}`, () => {
      expect(usesDeviceFlow(device, env, platform)).toBe(expected);
    });
  }
});

describe("the loopback listener", () => {
  test("listens on 127.0.0.1, answers one GET /callback, and stops", async () => {
    const listener = await startLoopback();
    expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const base = listener.redirectUri.replace("/callback", "");
    const waiting = listener.callback(5000);

    const otherPath = await fetch(`${base}/favicon.ico`);
    expect(otherPath.status).toBe(404);
    const post = await fetch(listener.redirectUri, { method: "POST" });
    expect(post.status).toBe(404);

    const answer = await fetch(`${listener.redirectUri}?code=c&state=s`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-security-policy")).toContain("default-src 'none'");
    const page = await answer.text();
    expect(page).toContain("Return to your terminal");
    expect(page).not.toMatch(/<(script|img|link)\b/);
    const query = await waiting;
    expect(Object.fromEntries(query)).toEqual({ code: "c", state: "s" });

    // The listener has stopped, so the port refuses the connection.
    const again = await fetch(`${listener.redirectUri}?code=other`).catch(() => undefined);
    expect(again).toBeUndefined();
  });

  test("a spare connection that never ends a request is closed with the listener, so the process can exit", async () => {
    const listener = await startLoopback();
    const port = Number(new URL(listener.redirectUri).port);
    const waiting = listener.callback(5000);

    // A browser holds a spare connection open that sends nothing. This one sends a partial request
    // instead, because a server with TCP_DEFER_ACCEPT, such as Bun on Linux, never accepts a socket
    // that sends nothing, so the test would see no close there.
    const spare = connect(port, "127.0.0.1");
    await new Promise((resolve) => spare.once("connect", resolve));
    const spareClosed = new Promise((resolve) => spare.once("close", resolve));
    spare.on("error", () => undefined);
    spare.write("GET /favicon.ico HTTP/1.1\r\n");
    await Bun.sleep(50);

    const answer = await fetch(`${listener.redirectUri}?code=c&state=s`);
    expect(answer.status).toBe(200);
    await answer.text();
    await waiting;

    const closed = await Promise.race([
      spareClosed.then(() => true),
      Bun.sleep(2000).then(() => false),
    ]);
    spare.destroy();
    expect(closed).toBe(true);
  });

  test("a request target that is no URL gets 404, and the listener keeps waiting", async () => {
    const listener = await startLoopback();
    const waiting = listener.callback(5000);
    const port = new URL(listener.redirectUri).port;
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), "127.0.0.1", () => {
        socket.write("GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      });
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString();
      });
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
    expect(raw).toStartWith("HTTP/1.1 404");
    expect((await fetch(`${listener.redirectUri}?state=s`)).status).toBe(200);
    expect((await waiting).get("state")).toBe("s");
  });

  test.skipIf(!IPV6_LOOPBACK)(
    "falls back to ::1 when the IPv4 address cannot be bound",
    async () => {
      // 192.0.2.1 (TEST-NET-1) is on no interface, so binding it fails as a missing 127.0.0.1 would.
      const listener = await startLoopback(["192.0.2.1", "::1"]);
      expect(listener.redirectUri).toMatch(/^http:\/\/\[::1\]:\d+\/callback$/);
      const waiting = listener.callback(5000);
      expect((await fetch(`${listener.redirectUri}?state=s`)).status).toBe(200);
      expect((await waiting).get("state")).toBe("s");
    },
  );

  test("no address that can be bound is CLI_INTERNAL naming --device", async () => {
    const error = (await startLoopback(["192.0.2.1"]).catch(
      (thrown: unknown) => thrown,
    )) as CliError;
    expect(error.code).toBe("CLI_INTERNAL");
    expect(error.message).toContain("--device");
  });

  test("no callback within the time is CLI_TIMEOUT, and the port is closed", async () => {
    const listener = await startLoopback();
    const error = (await listener.callback(50).catch((thrown: unknown) => thrown)) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe("CLI_TIMEOUT");
    const late = await fetch(`${listener.redirectUri}?code=c`).catch(() => undefined);
    expect(late).toBeUndefined();
  });
});
