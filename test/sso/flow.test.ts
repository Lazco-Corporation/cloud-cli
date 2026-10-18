import { describe, expect, test } from "bun:test";
import { CliError } from "../../src/core/errors";
import { startLoopback } from "../../src/sso/loopback";
import { usesDeviceFlow } from "../../src/sso/signIn";

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

    const again = await fetch(`${listener.redirectUri}?code=other`).catch(() => undefined);
    expect(again === undefined || again.status === 404).toBe(true);
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
