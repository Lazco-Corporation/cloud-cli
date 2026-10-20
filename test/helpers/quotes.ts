/** A quote as the API answers `POST <spend path>/quote`, with fixed figures. */
export function quoteBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    quoteId: "q-1",
    operationId: "compute.servers.create",
    currency: "TWD",
    amount: "402.500",
    period: { start: "2026-10-20T00:00:00.000Z", end: "2026-11-19T00:00:00.000Z" },
    lines: [
      {
        code: "plan",
        description: "Plan s1, 30 days",
        amount: "452.500",
        period: { start: "2026-10-20T00:00:00.000Z", end: "2026-11-19T00:00:00.000Z" },
      },
      { code: "coupon_discount", description: "Coupon WELCOME", amount: "-50.000", period: null },
    ],
    recurring: { amount: "452.500", interval: "30_days", startsAt: "2026-11-19T00:00:00.000Z" },
    accountBalance: "1000.000",
    sufficient: true,
    pricedAt: "2026-10-20T00:00:00.000Z",
    expiresAt: "2026-10-20T00:10:00.000Z",
    ...overrides,
  };
}
