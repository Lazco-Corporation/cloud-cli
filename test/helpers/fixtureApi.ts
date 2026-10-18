import type { OpenApiDocument } from "../../src/core/spec/types";
import { FakeApi, json, type RecordedRequest } from "./fakeApi";
import { loadFixture } from "./fixtures";

/**
 * What the fixture API answers. A test may change any field while the API
 * runs, and the next request sees it.
 */
export type FixtureState = {
  features?: Record<string, boolean>;
  scope?: string;
  spec?: OpenApiDocument;
  etag?: string;
};

/**
 * A fake API that serves the `surface` fixture as its spec and answers its
 * operations, for tests that run the whole CLI. The spec answers 304 to an
 * `If-None-Match` of its ETag.
 */
export function fixtureApi(state: FixtureState = {}): FakeApi {
  const fixture = loadFixture("surface");
  return new FakeApi((request: RecordedRequest) => {
    const route = `${request.method} ${request.path}`;
    const query = new URLSearchParams(request.search);
    if (route === "GET /v1/spec") {
      const etag = state.etag ?? '"fixture"';
      if (request.headers["if-none-match"] === etag) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      return json(200, state.spec ?? fixture, { etag });
    }
    if (route === "GET /v1/whoami") {
      return json(200, {
        organization: { id: "org-1", name: "Fixture Org" },
        role: "owner",
        principal: { kind: "api_token", scope: state.scope ?? "read_write", expiresAt: null },
        features: state.features ?? { dns: true },
      });
    }
    if (route === "GET /v1/servers") {
      const cursor = query.get("cursor");
      return cursor === "c-2"
        ? json(200, {
            data: [{ id: "srv-3", hostname: "web-3", region: "txg1" }],
            nextCursor: null,
          })
        : json(200, {
            data: [
              { id: "srv-1", hostname: "web-1", region: "txg1" },
              { id: "srv-2", hostname: "web-2", region: "txg1" },
            ],
            nextCursor: "c-2",
          });
    }
    if (route === "GET /v1/servers/srv-1") {
      return json(200, {
        id: "srv-1",
        hostname: "web-1\u001b[31m",
        status: "running",
        ipv4: "192.0.2.10",
      });
    }
    if (route === "POST /v1/servers") {
      return json(202, { taskId: "t-1", password: "once-only" });
    }
    if (request.method === "DELETE" && request.path.startsWith("/v1/servers/")) {
      return json(202, { taskId: "t-1" });
    }
    if (route === "GET /v1/tasks/t-1") {
      return json(200, { id: "t-1", status: "completed", progress: 100 });
    }
    if (route === "GET /v1/regions") {
      return json(200, [{ slug: "txg1" }, { slug: "tpe1" }]);
    }
    if (route === "GET /v1/dns/zones/z-1/rrsets") {
      return json(200, { rrsets: [] }, { etag: '"43"' });
    }
    if (route === "PATCH /v1/dns/zones/z-1/rrsets") {
      return json(200, { version: 44 });
    }
    return json(404, { error: "Not found", code: "NOT_FOUND", timestamp: "2026-10-18T00:00:00Z" });
  });
}

/** The requests other than the spec and `whoami`, as `METHOD path?query`. */
export function operationRequests(requests: readonly RecordedRequest[]): string[] {
  return requests
    .filter((request) => request.path !== "/v1/spec" && request.path !== "/v1/whoami")
    .map((request) => `${request.method} ${request.path}${request.search}`);
}
