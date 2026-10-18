import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../../src/core/request/rateLimiter";
import { fakeClock } from "../helpers/fakeApi";

describe("rate limiter", () => {
  test("starts are spaced 100 ms apart", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(clock);
    const starts: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      await limiter.acquire();
      starts.push(clock.time);
    }
    expect(starts.map((time) => time - (starts[0] as number))).toEqual([0, 100, 200]);
  });

  test("a timer that fires early sleeps again until the slot has come", async () => {
    const clock = fakeClock();
    // A sleep longer than 1 ms ends 1 ms before it should, as a real timer sometimes does.
    const early = {
      now: () => clock.time,
      sleep: async (milliseconds: number) => {
        clock.sleeps.push(milliseconds);
        clock.time += milliseconds > 1 ? milliseconds - 1 : milliseconds;
      },
    };
    const limiter = new RateLimiter(early);
    await limiter.acquire();
    const first = clock.time;
    await limiter.acquire();
    expect(clock.time - first).toBe(100);
    expect(clock.sleeps).toEqual([100, 1]);
  });
});
