import { FakeApi, json, type RecordedRequest } from "./fakeApi";
import { loadFixture } from "./fixtures";

export const ARTIFACT_WARNING = {
  code: "EXTERNAL_RESOURCE",
  file: "index.html",
  line: 3,
  detail: "https://example.com/a.png",
};

/** The answer of a publish or an update, as the API sends it. */
export function artifactAnswer(versionId: string, title = "Report"): Record<string, unknown> {
  return {
    id: "art-1",
    url: "https://staging.lazco.live/abcdefghijklmnopqrstuvwxyz",
    title,
    region: "tw-tpe",
    status: "active",
    versionId,
    createdAt: "2026-10-21T08:00:00.000Z",
    updatedAt: "2026-10-21T08:00:00.000Z",
    warnings: [ARTIFACT_WARNING],
  };
}

/**
 * The Artifacts API on 127.0.0.1: the `artifacts` fixture as the spec,
 * `whoami`, the publish, the read with its ETag and the update, which
 * answers 409 unless `If-Match` names the current version. `answer` lets a
 * test answer any request first.
 */
export class ArtifactsApi {
  readonly api: FakeApi;
  version = "ver-1";
  answer: ((request: RecordedRequest) => Response | undefined) | undefined;

  constructor() {
    this.api = new FakeApi((request) => this.answer?.(request) ?? this.route(request));
  }

  get apiUrl(): string {
    return this.api.apiUrl;
  }

  get requests(): RecordedRequest[] {
    return this.api.requests;
  }

  /** The API requests as `METHOD path`, without the spec and `whoami`. */
  calls(): string[] {
    return this.api.requests
      .filter((request) => request.path !== "/v1/spec" && request.path !== "/v1/whoami")
      .map((request) => `${request.method} ${request.path}`);
  }

  /** The body of the one write sent. */
  written(): { files: Array<{ path: string; encoding: string; content: string }> } & Record<
    string,
    unknown
  > {
    const writes = this.api.requests.filter(
      (request) => request.method === "POST" || request.method === "PUT",
    );
    if (writes.length !== 1) {
      throw new Error(`expected one write, got ${writes.length}`);
    }
    return writes[0]?.body as ReturnType<ArtifactsApi["written"]>;
  }

  stop(): void {
    this.api.stop();
  }

  private route(request: RecordedRequest): Response {
    const route = `${request.method} ${request.path}`;
    if (route === "GET /v1/spec") {
      return json(200, loadFixture("artifacts"));
    }
    if (route === "GET /v1/whoami") {
      return json(200, {
        organization: { id: "org-1", name: "Artifacts Org" },
        role: "owner",
        principal: { kind: "api_token", scope: "read_write", expiresAt: null },
        features: { artifacts: true },
      });
    }
    const etag = { etag: `"${this.version}"` };
    if (route === "POST /v1/labs/artifacts") {
      return json(201, artifactAnswer(this.version), etag);
    }
    if (route === "GET /v1/labs/artifacts/art-1") {
      return json(200, artifactAnswer(this.version), etag);
    }
    if (route === "PUT /v1/labs/artifacts/art-1") {
      if (request.headers["if-match"] !== `"${this.version}"`) {
        return json(409, {
          error: "The artifact has a newer version",
          code: "ARTIFACT_VERSION_CONFLICT",
        });
      }
      this.version = "ver-2";
      return json(200, artifactAnswer(this.version), { etag: `"${this.version}"` });
    }
    return json(404, { error: "Not found", code: "NOT_FOUND" });
  }
}
