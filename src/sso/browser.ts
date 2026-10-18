import { spawn } from "node:child_process";

/**
 * Opens a URL in the default browser without a shell, and does not wait for
 * the browser. Resolves `false` when no opener could be started, so the
 * caller can rely on the URL it printed.
 */
export function openInBrowser(url: string, platform: NodeJS.Platform): Promise<boolean> {
  const [command, ...args] =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? // `start` of cmd would read `&` in the URL as a command separator.
          ["rundll32", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  return new Promise((resolve) => {
    try {
      const child = spawn(command as string, args, { detached: true, stdio: "ignore" });
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
