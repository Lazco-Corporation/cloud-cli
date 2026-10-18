/**
 * Time as the request pipeline sees it, so tests can run it without waiting.
 * After `sleep(n)` resolves, `now()` must have moved forward, or a caller
 * that sleeps until a time never ends.
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

/** Wall-clock time, for a value that is stored or compared with a date, such as a cache time. */
export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: sleepFor,
};

/** Time that never jumps back, for spacing requests apart. */
export const MONOTONIC_CLOCK: Clock = {
  now: () => performance.now(),
  sleep: sleepFor,
};
