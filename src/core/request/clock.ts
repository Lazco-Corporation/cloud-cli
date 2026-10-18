/** Time as the request pipeline sees it, so tests can run it without waiting. */
export type Clock = {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
};

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, milliseconds));
    }),
};
