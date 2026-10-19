import { createHash } from "node:crypto";
import type { OpenApiDocument } from "../../src/core/spec/types";
import { loadFixture } from "./fixtures";

export type PagesRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** The JSON body of an API request. */
  body: unknown;
  /** The byte count of a storage PUT. */
  bytes: number;
};

export type StorageAnswer = (request: {
  path: string;
  url: URL;
  headers: Record<string, string>;
  bytes: Uint8Array;
  attempt: number;
}) => Response | Promise<Response> | undefined;

type FakeDeployment = {
  id: string;
  siteId: string;
  status: string;
  fileCount: number;
  totalBytes: number;
  indexDocumentChoice: string | null;
  uploadExpiresAt: string;
  finalizedAt: string | null;
  error: string | null;
  createdAt: string;
  files: Array<{ path: string; size: number; sha256: string }>;
  generation: number;
  polls: number;
};

export type PagesApiState = {
  scope: string;
  rules: {
    limits: { fileBytes: number; totalBytes: number; fileCount: number; textBytes: number };
    contentExtensions: string[];
    lastExtensions: string[];
    uploadUrlTtlSeconds: number;
  };
  site: { id: string; hostname: string; status: string };
  /** The server's time, for `Date` and `uploadExpiresAt`. */
  now: () => number;
  /** The statuses that reads after finalize answer in turn. The last one stays. */
  afterFinalize: string[];
  /** The `error` of a deployment that ends `failed`. */
  failure: string | null;
  /** Answers a storage PUT instead of the default check and store, when it returns a response. */
  storage?: StorageAnswer;
  /** Answers the deploy start's index rule. */
  indexRule: "root_index" | "single_html" | "not_found" | "custom";
  /** Called on each API request before it is answered, such as to interrupt a run. */
  onRequest?: (request: PagesRequest) => void | Promise<void>;
  /** Answers an API request instead of the fake, when it returns a response. */
  answer?: (request: PagesRequest) => Response | undefined;
  /** The spec to serve instead of the `pages` fixture. */
  spec?: OpenApiDocument;
  /** The files of the live deployment, by path, so a redeploy uploads only changed files. */
  live: Map<string, string>;
  /** Every object written to storage, by path. */
  stored: Map<string, Uint8Array>;
  deployments: Map<string, FakeDeployment>;
};

const MIB = 1024 * 1024;
const HTML = new Set(["html", "htm", "xhtml"]);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function defaultPagesState(): PagesApiState {
  return {
    scope: "read_write",
    rules: {
      limits: {
        fileBytes: 25 * MIB,
        totalBytes: 1024 * MIB,
        fileCount: 20_000,
        textBytes: 20 * MIB,
      },
      contentExtensions: ["cjs", "css", "htm", "html", "js", "mjs", "svg", "xhtml"],
      lastExtensions: ["htm", "html", "xhtml"],
      uploadUrlTtlSeconds: 3600,
    },
    site: { id: "site-1", hostname: "docs.staging.lazco.page", status: "active" },
    now: () => Date.now(),
    afterFinalize: ["finalizing", "live"],
    failure: null,
    indexRule: "root_index",
    live: new Map(),
    stored: new Map(),
    deployments: new Map(),
  };
}

function json(status: number, body: unknown, now: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", date: new Date(now).toUTCString() },
  });
}

function publicDeployment(deployment: FakeDeployment): Record<string, unknown> {
  const { files: _files, generation: _generation, polls: _polls, ...rest } = deployment;
  return rest;
}

/**
 * The Pages API and its storage on 127.0.0.1, in one server: the `pages`
 * fixture as the spec, `whoami`, the deploy rules, a site, the deploy start
 * with signed URLs under `/storage/`, renewal, finalize, the read and cancel.
 */
export class PagesApi {
  readonly state: PagesApiState;
  readonly requests: PagesRequest[] = [];
  private readonly server: ReturnType<typeof Bun.serve>;
  private nextDeployment = 1;
  private readonly attempts = new Map<string, number>();

  constructor(state: Partial<PagesApiState> = {}) {
    this.state = { ...defaultPagesState(), ...state };
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.answer(request),
    });
  }

  get origin(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  get apiUrl(): string {
    return `${this.origin}/v1`;
  }

  stop(): void {
    this.server.stop(true);
  }

  /** The API requests as `METHOD path`, without the spec, `whoami` and storage. */
  apiCalls(): string[] {
    return this.requests
      .filter(
        (request) =>
          request.path.startsWith("/v1/") &&
          request.path !== "/v1/spec" &&
          request.path !== "/v1/whoami",
      )
      .map((request) => `${request.method} ${request.path}`);
  }

  /** The storage PUTs, as their paths in the site. */
  puts(): string[] {
    return this.requests
      .filter((request) => request.method === "PUT")
      .map((request) => decodeURIComponent(request.path.split("/").slice(3).join("/")));
  }

  /** True when any request changed something: every API request but a GET. */
  sentWrites(): boolean {
    return this.requests.some((request) => request.method !== "GET");
  }

  private async answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = this.state.now();
    const headers = Object.fromEntries(request.headers.entries());
    if (request.method === "PUT" && url.pathname.startsWith("/storage/")) {
      const bytes = new Uint8Array(await request.arrayBuffer());
      this.requests.push({
        method: "PUT",
        path: url.pathname,
        headers,
        body: undefined,
        bytes: bytes.length,
      });
      return this.store(url, headers, bytes);
    }
    const text = await request.text();
    const body = text ? JSON.parse(text) : undefined;
    const recorded = {
      method: request.method,
      path: url.pathname,
      headers,
      body,
      bytes: text.length,
    };
    this.requests.push(recorded);
    await this.state.onRequest?.(recorded);
    const custom = this.state.answer?.(recorded);
    if (custom) {
      return custom;
    }
    const route = `${request.method} ${url.pathname}`;
    const sitePrefix = `/v1/labs/pages/sites/${this.state.site.id}`;
    if (route === "GET /v1/spec") {
      return json(200, this.state.spec ?? loadFixture("pages"), now);
    }
    if (route === "GET /v1/whoami") {
      return json(
        200,
        {
          organization: { id: "org-1", name: "Pages Org" },
          role: "owner",
          principal: { kind: "api_token", scope: this.state.scope, expiresAt: null },
          features: { pages: true },
        },
        now,
      );
    }
    if (route === "GET /v1/labs/pages/deploy-rules") {
      return json(200, this.state.rules, now);
    }
    if (route === `GET ${sitePrefix}`) {
      return json(200, { ...this.state.site, organizationId: "org-1" }, now);
    }
    if (route === `POST ${sitePrefix}/deployments`) {
      return this.start(body as { files: FakeDeployment["files"] }, now);
    }
    const match = new RegExp(`^${sitePrefix}/deployments/([^/]+)(/[a-z]+)?$`).exec(url.pathname);
    const deployment = match ? this.state.deployments.get(match[1] as string) : undefined;
    if (match && !deployment) {
      return json(404, { error: "Not found", code: "PAGES_DEPLOYMENT_NOT_FOUND" }, now);
    }
    if (deployment) {
      const action = `${request.method} ${match?.[2] ?? ""}`;
      if (action === "GET ") {
        if (deployment.status !== "uploading" && deployment.status !== "cancelled") {
          const sequence = this.state.afterFinalize;
          deployment.status = sequence[Math.min(deployment.polls, sequence.length - 1)] as string;
          deployment.polls += 1;
          if (deployment.status === "failed") {
            deployment.error = this.state.failure;
          }
          if (deployment.status === "live") {
            this.state.live = new Map(deployment.files.map((file) => [file.path, file.sha256]));
          }
        }
        return json(200, publicDeployment(deployment), now);
      }
      if (action === "POST /finalize") {
        if (deployment.status !== "uploading") {
          return json(
            409,
            {
              error: "Not uploading",
              code: "PAGES_DEPLOYMENT_NOT_UPLOADING",
              status: deployment.status,
            },
            now,
          );
        }
        deployment.status = "finalizing";
        deployment.finalizedAt = new Date(now).toISOString();
        return json(202, publicDeployment(deployment), now);
      }
      if (action === "POST /cancel") {
        if (deployment.status !== "uploading") {
          return json(
            409,
            {
              error: "Not uploading",
              code: "PAGES_DEPLOYMENT_NOT_UPLOADING",
              status: deployment.status,
            },
            now,
          );
        }
        deployment.status = "cancelled";
        return json(200, publicDeployment(deployment), now);
      }
      if (action === "POST /uploads") {
        if (deployment.status !== "uploading") {
          return json(
            409,
            {
              error: "Not uploading",
              code: "PAGES_DEPLOYMENT_NOT_UPLOADING",
              status: deployment.status,
            },
            now,
          );
        }
        if (Date.parse(deployment.uploadExpiresAt) <= now) {
          return json(
            409,
            {
              error: "The upload window ended",
              code: "PAGES_UPLOAD_EXPIRED",
              uploadExpiresAt: deployment.uploadExpiresAt,
            },
            now,
          );
        }
        const paths = (body as { paths: string[] }).paths;
        const files = deployment.files.filter((file) => paths.includes(file.path));
        if (files.length !== paths.length) {
          return json(400, { error: "Not in the manifest", code: "PAGES_MANIFEST_INVALID" }, now);
        }
        deployment.generation += 1;
        deployment.uploadExpiresAt = new Date(
          now + this.state.rules.uploadUrlTtlSeconds * 1000,
        ).toISOString();
        return json(
          200,
          { deployment: publicDeployment(deployment), uploads: this.sign(deployment, files) },
          now,
        );
      }
    }
    return json(404, { error: "Not found", code: "NOT_FOUND" }, now);
  }

  private start(
    body: { files: FakeDeployment["files"] & Array<{ contentBase64?: string }> },
    now: number,
  ): Response {
    for (const deployment of this.state.deployments.values()) {
      if (deployment.status === "uploading" || deployment.status === "finalizing") {
        return json(409, { error: "In progress", code: "PAGES_DEPLOYMENT_IN_PROGRESS" }, now);
      }
    }
    for (const file of body.files) {
      const isText = this.state.rules.contentExtensions.includes(extensionOf(file.path));
      if (isText !== (file.contentBase64 !== undefined)) {
        return json(400, { error: `${file.path} content`, code: "PAGES_MANIFEST_INVALID" }, now);
      }
      if (file.contentBase64 !== undefined) {
        const hash = createHash("sha256")
          .update(Buffer.from(file.contentBase64, "base64"))
          .digest("hex");
        if (hash !== file.sha256) {
          return json(400, { error: `${file.path} hash`, code: "PAGES_TEXT_MISMATCH" }, now);
        }
      }
    }
    const id = `dep-${this.nextDeployment}`;
    this.nextDeployment += 1;
    const files = body.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
    const deployment: FakeDeployment = {
      id,
      siteId: this.state.site.id,
      status: "uploading",
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      indexDocumentChoice: files.some((file) => file.path === "index.html") ? "index.html" : null,
      uploadExpiresAt: new Date(now + this.state.rules.uploadUrlTtlSeconds * 1000).toISOString(),
      finalizedAt: null,
      error: null,
      createdAt: new Date(now).toISOString(),
      files,
      generation: 0,
      polls: 0,
    };
    this.state.deployments.set(id, deployment);
    const changed = files.filter((file) => this.state.live.get(file.path) !== file.sha256);
    return json(
      201,
      {
        deployment: publicDeployment(deployment),
        uploads: this.sign(deployment, changed),
        index: {
          rule: this.state.indexRule,
          indexDocument: this.state.indexRule === "not_found" ? null : "index.html",
        },
      },
      now,
    );
  }

  /** Signed uploads in upload order: every file that is not HTML first. */
  private sign(deployment: FakeDeployment, files: FakeDeployment["files"]) {
    const ordered = [
      ...files.filter((file) => !HTML.has(extensionOf(file.path))),
      ...files.filter((file) => HTML.has(extensionOf(file.path))),
    ];
    return ordered.map((file) => ({
      path: file.path,
      url: `${this.origin}/storage/${deployment.id}/${file.path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?generation=${deployment.generation}&X-Amz-Signature=fake`,
      headers: {
        "content-type": "application/octet-stream",
        "x-amz-checksum-sha256": Buffer.from(file.sha256, "hex").toString("base64"),
      },
    }));
  }

  private async store(
    url: URL,
    headers: Record<string, string>,
    bytes: Uint8Array,
  ): Promise<Response> {
    const path = decodeURIComponent(url.pathname.split("/").slice(3).join("/"));
    const attempt = (this.attempts.get(path) ?? 0) + 1;
    this.attempts.set(path, attempt);
    const custom = await this.state.storage?.({ path, url, headers, bytes, attempt });
    if (custom) {
      return custom;
    }
    const checksum = createHash("sha256").update(bytes).digest("base64");
    if (
      headers["x-amz-checksum-sha256"] !== checksum ||
      Number(headers["content-length"]) !== bytes.length
    ) {
      return new Response("<Error><Code>BadDigest</Code></Error>", {
        status: 400,
        headers: { "content-type": "application/xml" },
      });
    }
    this.state.stored.set(path, bytes);
    return new Response(null, { status: 200 });
  }
}
