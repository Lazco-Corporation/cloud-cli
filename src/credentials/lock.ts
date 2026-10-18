import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { CliError } from "../core/errors";
import { type Clock, MONOTONIC_CLOCK } from "../core/request/clock";

/** How long a process waits for another one's lock before it gives up. */
export const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 100;

/** `<config dir>/lazco/locks/<profile>.lock`, beside the config file it guards. */
export function profileLockPath(configPath: string, profileName: string): string {
  return join(dirname(configPath), "locks", `${profileName}.lock`);
}

/**
 * The lock of the config file itself. A profile name starts with a letter or
 * a digit, so no profile lock can share this name.
 */
export function configLockPath(configPath: string): string {
  return join(dirname(configPath), "locks", "_config.lock");
}

type LockOptions = { clock?: Clock; waitMs?: number };

/**
 * Runs `task` while this process holds an exclusive lock. Waits at most 30
 * seconds for it, then fails with `CLI_TIMEOUT` naming `holderOf`.
 */
async function withLock<T>(
  lockPath: string,
  holderOf: string,
  options: LockOptions,
  task: () => Promise<T>,
): Promise<T> {
  const clock = options.clock ?? MONOTONIC_CLOCK;
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = clock.now() + waitMs;
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
          `The lock of ${holderOf} could not be taken: ${(error as Error).message}`,
        );
      }
      if (clock.now() >= deadline) {
        throw new CliError(
          "CLI_TIMEOUT",
          `Another lazco process held the lock of ${holderOf} for ${waitMs / 1000} seconds`,
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

/**
 * Runs `task` while this process holds the lock of one profile, so two
 * processes never refresh or replace one sign-in at once.
 */
export function withProfileLock<T>(
  options: { configPath: string; profileName: string } & LockOptions,
  task: () => Promise<T>,
): Promise<T> {
  return withLock(
    profileLockPath(options.configPath, options.profileName),
    `profile ${options.profileName}`,
    options,
    task,
  );
}

/**
 * Runs `task` while this process holds the lock of the config file, so a
 * read, change and write of the file never loses another process's write.
 * Taken inside a profile lock, never around one.
 */
export function withConfigLock<T>(
  options: { configPath: string } & LockOptions,
  task: () => Promise<T>,
): Promise<T> {
  return withLock(configLockPath(options.configPath), options.configPath, options, task);
}
