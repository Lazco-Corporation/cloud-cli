/**
 * Time as the request pipeline sees it, so tests can run it without waiting.
 * A clock that drives `RateLimiter` must not move back after `sleep(n)`
 * resolves, or the limiter sleeps again for the time it lost. Only
 * `MONOTONIC_CLOCK`, or a test clock, promises that.
 */
export type Clock = {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
};

function sleepFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, milliseconds));
  });
}

/**
 * Wall-clock time, for a value that is stored or compared with a date, such
 * as a cache time or the expiry of an access token. It also measures the
 * deadline of a task wait and of a device sign-in, which a change of the
 * system clock moves by as much.
 */
export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: sleepFor,
};

/** Time that never jumps back, for spacing requests apart. */
export const MONOTONIC_CLOCK: Clock = {
  now: () => performance.now(),
  sleep: sleepFor,
};
