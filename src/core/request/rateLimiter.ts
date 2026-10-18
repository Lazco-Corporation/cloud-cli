import { type Clock, MONOTONIC_CLOCK } from "./clock";

/** At most 10 request starts a second from one process. */
export const REQUESTS_PER_SECOND = 10;

/**
 * Spaces request starts evenly, one slot every 100 ms, instead of allowing a
 * burst, so that no window of one second ever holds more than 10 starts.
 * A request that comes early waits for its slot rather than failing.
 */
export class RateLimiter {
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private nextSlot = Number.NEGATIVE_INFINITY;

  constructor(clock: Clock = MONOTONIC_CLOCK, requestsPerSecond = REQUESTS_PER_SECOND) {
    this.clock = clock;
    this.intervalMs = 1000 / requestsPerSecond;
  }

  async acquire(): Promise<void> {
    let now = this.clock.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    // A timer may fire a millisecond early, so sleep again until the slot has come.
    while (slot > now) {
      await this.clock.sleep(slot - now);
      now = this.clock.now();
    }
  }
}
