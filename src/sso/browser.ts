import { type ChildProcess, spawn } from "node:child_process";

/** Starts a program without a shell, as `child_process.spawn` does, so tests can stand in. */
export type Spawner = (
  command: string,
  args: readonly string[],
  options: { detached: true; stdio: "ignore" },
) => ChildProcess;

/** The program and arguments that open a URL in the default browser of a platform. */
export function browserCommand(url: string, platform: NodeJS.Platform): [string, ...string[]] {
  if (platform === "darwin") {
    return ["open", url];
  }
  if (platform === "win32") {
    // `start` of cmd would read `&` in the URL as a command separator.
    return ["rundll32", "url.dll,FileProtocolHandler", url];
  }
  return ["xdg-open", url];
}

/**
 * Opens a URL in the default browser without a shell, and does not wait for
 * the browser. Resolves `false` when no opener could be started, so the
 * caller can rely on the URL it printed.
 */
export function openInBrowser(
  url: string,
  platform: NodeJS.Platform,
  spawnProcess: Spawner = spawn,
): Promise<boolean> {
  const [command, ...args] = browserCommand(url, platform);
  return new Promise((resolve) => {
    try {
      const child = spawnProcess(command, args, { detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
