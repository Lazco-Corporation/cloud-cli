import { FakeApi, json, type RecordedRequest } from "./fakeApi";
import { loadFixture } from "./fixtures";
import { quoteBody } from "./quotes";

/**
 * What the spend API answers. A test may change a field while the API runs:
 * `quote` is the next quote answer, `spendAnswer` the answer of every spend.
 */
export type SpendState = {
  quote: Record<string, unknown>;
  quoteAnswer?: () => Response;
  spendAnswer?: (request: RecordedRequest) => Response;
  /** The quote `GET /v1/billing/quotes/:quoteId` answers, or `null` for its 404. */
  storedQuote?: Record<string, unknown> | null;
};

const SPEND_ROUTES: ReadonlyMap<string, () => unknown> = new Map<string, () => unknown>([
  ["POST /v1/servers", () => ({ taskId: "t-1", serverId: "srv-9" })],
  ["POST /v1/servers/srv-1/upgrade", () => ({ id: "srv-1", planSlug: "s2" })],
  ["POST /v1/labs/pages/packs", () => ({ id: "pack-1", status: "active" })],
  ["DELETE /v1/servers/srv-1/cancel-renewal", () => ({ id: "srv-1", renewing: true })],
  ["POST /v1/servers/srv-1/reinstall", () => ({ taskId: "t-2" })],
]);

/**
 * A fake API that serves the `spend` fixture, the phase C spec's spend and
 * quote operations, answers every `.../quote` with `state.quote`, and every
 * spend route above with a fixed body.
 */
export function spendApi(state: SpendState): FakeApi {
  const spec = loadFixture("spend");
  return new FakeApi((request) => {
    const route = `${request.method} ${request.path}`;
    if (route === "GET /v1/spec") {
      return json(200, spec, { etag: '"spend"' });
    }
    if (route === "GET /v1/whoami") {
      return json(200, {
        organization: { id: "org-1", name: "Spend Org" },
        role: "owner",
        principal: { kind: "api_token", scope: "read_write", expiresAt: null },
        features: { pages: true, t4: true, networkResources: true },
      });
    }
    if (request.method === "POST" && request.path.endsWith("/quote")) {
      return state.quoteAnswer ? state.quoteAnswer() : json(201, state.quote);
    }
    if (request.method === "GET" && request.path.startsWith("/v1/billing/quotes/")) {
      const stored = state.storedQuote === undefined ? state.quote : state.storedQuote;
      return stored === null
        ? json(404, { error: "Not found", code: "QUOTE_NOT_FOUND" })
        : json(200, { ...stored, status: "open" });
    }
    const body = SPEND_ROUTES.get(route);
    if (body) {
      return state.spendAnswer ? state.spendAnswer(request) : json(200, body());
    }
    return json(404, { error: "Not found", code: "NOT_FOUND" });
  });
}

/** The requests other than the spec and `whoami`, as `METHOD path`. */
export function sentRoutes(api: FakeApi): string[] {
  return api.requests
    .filter((request) => request.path !== "/v1/spec" && request.path !== "/v1/whoami")
    .map((request) => `${request.method} ${request.path}`);
}

/** A quote for the upgrade of `srv-1`. */
export function upgradeQuote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return quoteBody({
    quoteId: "q-up",
    operationId: "compute.servers.upgrade",
    amount: "100.000",
    lines: [
      {
        code: "upgrade_proration",
        description: "Plan s1 to s2, 12 days",
        amount: "100.000",
        period: { start: "2026-10-20T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" },
      },
    ],
    period: { start: "2026-10-20T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" },
    recurring: { amount: "250.000", interval: "30_days", startsAt: "2026-11-01T00:00:00.000Z" },
    ...overrides,
  });
}
