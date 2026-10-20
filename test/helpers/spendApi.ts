import { HTTP_METHODS, type OpenApiDocument } from "../../src/core/spec/types";
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
  /** The spec to serve, in place of the `spend` fixture. */
  spec?: OpenApiDocument;
};

type SpendRoute = { method: string; pattern: RegExp; operationId: string };

/** Every spend operation of a spec, as the method and a pattern of its path. */
function spendRoutes(spec: OpenApiDocument): SpendRoute[] {
  const routes: SpendRoute[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      const annotation = operation?.["x-lazco"] as { kind?: string } | undefined;
      if (operation && annotation?.kind === "spend") {
        routes.push({
          method: method.toUpperCase(),
          pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`),
          operationId: operation.operationId as string,
        });
      }
    }
  }
  return routes;
}

/**
 * A fake API that serves the `spend` fixture, the phase C spec's spend and
 * quote operations. It answers every `.../quote` with `state.quote`, and
 * every spend operation of the spec: `compute.servers.create` with the 202
 * of a task, as the API does, and every other one with `{ spent: <operationId> }`.
 */
export function spendApi(state: SpendState): FakeApi {
  const fixture = loadFixture("spend");
  return new FakeApi((request) => {
    const spec = state.spec ?? fixture;
    const route = `${request.method} ${request.path}`;
    if (route === "GET /v1/spec") {
      return json(200, spec, { etag: state.spec ? '"spend-changed"' : '"spend"' });
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
        : json(200, { status: "open", ...stored });
    }
    const spend = spendRoutes(spec).find(
      (candidate) => candidate.method === request.method && candidate.pattern.test(request.path),
    );
    if (spend) {
      if (state.spendAnswer) {
        return state.spendAnswer(request);
      }
      return spend.operationId === "compute.servers.create"
        ? json(202, { taskId: "t-1", serverId: "srv-9" })
        : json(200, { spent: spend.operationId });
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
