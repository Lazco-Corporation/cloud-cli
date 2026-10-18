import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { browserCommand, openInBrowser, type Spawner } from "../../src/sso/browser";

const URL_WITH_AMPERSANDS = "https://cloud.lazco.tw/oauth/authorize?a=1&b=2";

/** A spawner that records its call and emits one event, as a started or a missing program does. */
function fakeSpawner(event: "spawn" | "error" | "throw") {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let unrefs = 0;
  const spawner: Spawner = (command, args) => {
    calls.push({ command, args });
    if (event === "throw") {
      throw new Error("EPERM");
    }
    const child = Object.assign(new EventEmitter(), {
      unref: () => {
        unrefs += 1;
      },
    });
    queueMicrotask(() => child.emit(event, new Error("ENOENT")));
    return child as unknown as ChildProcess;
  };
  return { spawner, calls, unrefs: () => unrefs };
}

describe("the browser opener", () => {
  test("each platform's opener gets the URL as one argument, with no shell", () => {
    expect(browserCommand(URL_WITH_AMPERSANDS, "darwin")).toEqual(["open", URL_WITH_AMPERSANDS]);
    expect(browserCommand(URL_WITH_AMPERSANDS, "linux")).toEqual(["xdg-open", URL_WITH_AMPERSANDS]);
    expect(browserCommand(URL_WITH_AMPERSANDS, "win32")).toEqual([
      "rundll32",
      "url.dll,FileProtocolHandler",
      URL_WITH_AMPERSANDS,
    ]);
  });

  test("a started opener resolves true and is not waited for", async () => {
    const fake = fakeSpawner("spawn");
    expect(await openInBrowser(URL_WITH_AMPERSANDS, "darwin", fake.spawner)).toBe(true);
    expect(fake.calls).toEqual([{ command: "open", args: [URL_WITH_AMPERSANDS] }]);
    expect(fake.unrefs()).toBe(1);
  });

  test("a missing opener resolves false", async () => {
    expect(await openInBrowser(URL_WITH_AMPERSANDS, "linux", fakeSpawner("error").spawner)).toBe(
      false,
    );
    expect(await openInBrowser(URL_WITH_AMPERSANDS, "linux", fakeSpawner("throw").spawner)).toBe(
      false,
    );
  });
});
