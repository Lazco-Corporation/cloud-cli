import { join } from "node:path";
import { readJsonFile, writeFileAtomic } from "../config/atomicFile";
import { sha256Hex } from "../config/paths";
import { toToolError } from "../core/errors";
import { type ApiClient, requireJson } from "../core/request/client";
import { type Clock, SYSTEM_CLOCK } from "../core/request/clock";

/** A `whoami` answer younger than this is used without a request. */
export const WHOAMI_FRESH_MS = 10 * 60 * 1000;

type WhoamiEntry = { apiUrl: string; checkedAt: number; whoami: unknown };

/** The cache file of one credential, named by its hash so the file never holds it. */
export function whoamiCachePath(cacheDirectory: string, credential: string): string {
  return join(cacheDirectory, "whoami", `${sha256Hex(credential)}.json`);
}

/**
 * The `features` of the signed-in organization, from a 10-minute cache or
 * `GET /whoami`. `undefined` when they cannot be read, which hides nothing.
 */
export async function readFeatures(options: {
  client: ApiClient;
  credential: string;
  cacheDirectory: string;
  warn: (message: string) => void;
  clock?: Clock;
}): Promise<Record<string, boolean> | undefined> {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const path = whoamiCachePath(options.cacheDirectory, options.credential);
  const cached = (await readJsonFile(path)) as Partial<WhoamiEntry> | undefined;
  let whoami: unknown;
  if (
    cached?.apiUrl === options.client.apiUrl &&
    typeof cached.checkedAt === "number" &&
    clock.now() - cached.checkedAt < WHOAMI_FRESH_MS
  ) {
    whoami = cached.whoami;
  } else {
    try {
      whoami = requireJson(await options.client.call({ method: "GET", path: "/whoami" }));
    } catch (error) {
      options.warn(
        `the organization's features could not be read, so no command is hidden: ${toToolError(error).message}`,
      );
      return undefined;
    }
    try {
      await writeFileAtomic(
        path,
        JSON.stringify({ apiUrl: options.client.apiUrl, checkedAt: clock.now(), whoami }),
      );
    } catch {
      // A cache that cannot be written only costs one more request next time.
    }
  }
  const features = (whoami as { features?: unknown } | null)?.features;
  if (features === null || typeof features !== "object") {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(features).filter(([, value]) => typeof value === "boolean"),
  ) as Record<string, boolean>;
}

/** True when an operation's feature is reported off. A feature `whoami` does not name stays visible. */
export function isHidden(
  feature: string | null,
  features: Record<string, boolean> | undefined,
): boolean {
  return feature !== null && features?.[feature] === false;
}
