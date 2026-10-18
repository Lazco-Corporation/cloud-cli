import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { CliError } from "../core/errors";
import { type Clock, MONOTONIC_CLOCK } from "../core/request/clock";

/** How long a process waits for another one's refresh before it gives up. */
export const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 100;

/** `<config dir>/lazco/locks/<profile>.lock`, beside the config file it guards. */
export function profileLockPath(configPath: string, profileName: string): string {
  return join(dirname(configPath), "locks", `${profileName}.lock`);
}

/**
 * Runs `task` while this process holds the exclusive lock of one profile,
 * so two processes never refresh or replace one sign-in at once. Waits at
 * most 30 seconds for the lock, then fails with `CLI_TIMEOUT`.
 */
export async function withProfileLock<T>(
  options: { configPath: string; profileName: string; clock?: Clock; waitMs?: number },
  task: () => Promise<T>,
): Promise<T> {
  const clock = options.clock ?? MONOTONIC_CLOCK;
  const lockPath = profileLockPath(options.configPath, options.profileName);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = clock.now() + (options.waitMs ?? LOCK_WAIT_MS);
  let release: () => Promise<void>;
  for (;;) {
    try {
      release = await lockfile.lock(lockPath, {
        lockfilePath: lockPath,
        realpath: false,
        // A holder that died leaves the lock, which goes stale after 10 seconds without an update.
        stale: 10_000,
        // A lock that went stale while held is no worse than two refreshes at once, which the
        // provider answers with one pair, so it does not end the process.
        onCompromised: () => undefined,
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") {
        throw new CliError(
          "CLI_INTERNAL",
          `The lock of profile ${options.profileName} could not be taken: ${(error as Error).message}`,
        );
      }
      if (clock.now() >= deadline) {
        throw new CliError(
          "CLI_TIMEOUT",
          `Another lazco process held the lock of profile ${options.profileName} for ${(options.waitMs ?? LOCK_WAIT_MS) / 1000} seconds`,
          { lock: lockPath },
        );
      }
      await clock.sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await task();
  } finally {
    await release().catch(() => undefined);
  }
}
