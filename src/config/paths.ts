import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export type PathEnvironment = {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
};

export function currentPathEnvironment(): PathEnvironment {
  return { env: process.env, platform: process.platform, home: homedir() };
}

/** `<cache dir>/lazco`: `%LOCALAPPDATA%` on Windows, else `$XDG_CACHE_HOME` or `~/.cache`. */
export function cacheRoot(paths: PathEnvironment): string {
  if (paths.platform === "win32") {
    return join(paths.env.LOCALAPPDATA || join(paths.home, "AppData", "Local"), "lazco");
  }
  return join(paths.env.XDG_CACHE_HOME || join(paths.home, ".cache"), "lazco");
}

/** `config.json` of lazco: `%APPDATA%\lazco` on Windows, else `$XDG_CONFIG_HOME/lazco` or `~/.config/lazco`. */
export function configFilePath(paths: PathEnvironment): string {
  if (paths.platform === "win32") {
    return join(
      paths.env.APPDATA || join(paths.home, "AppData", "Roaming"),
      "lazco",
      "config.json",
    );
  }
  return join(paths.env.XDG_CONFIG_HOME || join(paths.home, ".config"), "lazco", "config.json");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
