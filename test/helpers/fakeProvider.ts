import { createHash, randomBytes } from "node:crypto";
import { writeConfig } from "../../src/config/configFile";
import type { SsoRecord } from "../../src/credentials/ssoRecord";
import { FakeApi, json, type RecordedRequest } from "./fakeApi";

/** What the fake browser does on the authorize page. */
export type BrowserChoice =
  | "allow"
  | "deny"
  | "forge-state"
  | "wrong-iss"
  | "no-iss"
  | "never-return";

type Family = {
  id: number;
  organizationId: string;
  scope: "read" | "read_write";
  revoked: boolean;
  deviceName: string | undefined;
};

type IssuedToken = { family: Family; expiresAt: number };

type PendingCode = {
  redirectUri: string;
  challenge: string;
  scope: "read" | "read_write";
  organizationId: string;
};

const ORGANIZATIONS: Record<string, string> = {
  "org-a": "Org A",
  "org-b": "Org B",
};

function oauthError(error: string, status = 400) {
  return json(status, { error, error_description: `fake ${error}` });
}

function scopeOf(requested: string | undefined): "read" | "read_write" {
  return requested?.split(" ").includes("lazco.write") ? "read_write" : "read";
}

function grantedScope(scope: "read" | "read_write"): string {
  return scope === "read_write" ? "openid lazco.read lazco.write" : "openid lazco.read";
}

/**
 * An OpenID provider and API on 127.0.0.1 that behaves like the Lazco
 * backend for `lazco-cli`: discovery, the authorize redirect, the code,
 * device and refresh grants with rotation, revocation, and `whoami`.
 */
export class FakeProvider {
  readonly api: FakeApi;
  /** What the fake browser does on the authorize page. */
  browser: BrowserChoice = "allow";
  /** The organization the user picks on the consent screen, else the hint, else `org-a`. */
  pick: string | undefined;
  /**
   * The answers of the device grant, in turn, until `approve`: an OAuth error,
   * `rate-limited` for a 429, or `pending-forever`, which never moves on.
   */
  deviceAnswers: string[] = ["approve"];
  /** The `expires_in` of every access token. */
  accessLifetimeSeconds = 3600;
  /** How long a refresh answer waits, so two processes overlap. */
  refreshDelayMs = 0;
  /** `whoami` answers 403 to every token, as for a member removed after the consent. */
  refuseWhoami = false;
  /** Answers of `whoami` for these access tokens are 401, as after a revocation the CLI has not seen. */
  readonly rejectedAccessTokens = new Set<string>();
  /** Answers every other request, such as the spec, when set. */
  fallback: ((request: RecordedRequest) => Response | Promise<Response>) | undefined;
  readonly families: Family[] = [];
  readonly authorizeUrls: URL[] = [];
  readonly revoked: string[] = [];
  private readonly accessTokens = new Map<string, IssuedToken>();
  private readonly refreshTokens = new Map<string, { family: Family; rotated: boolean }>();
  private readonly codes = new Map<string, PendingCode>();
  private deviceRequest: { scope: "read" | "read_write"; hint: string | undefined } | undefined;

  constructor() {
    this.api = new FakeApi((request) => this.handle(request));
  }

  get apiUrl(): string {
    return this.api.apiUrl;
  }

  get issuer(): string {
    return `${this.api.origin}/issuer`;
  }

  stop(): void {
    this.api.stop();
  }

  /** The requests to one path below the API, such as `/oidc/token`. */
  requestsTo(path: string, grantType?: string): RecordedRequest[] {
    return this.api.requests.filter(
      (request) =>
        request.path === `/v1${path}` &&
        (grantType === undefined ||
          (request.body as Record<string, string> | undefined)?.grant_type === grantType),
    );
  }

  /** A family and its first pair, as a finished sign-in would leave them. */
  issue(
    organizationId: string,
    scope: "read" | "read_write",
    lifetimeSeconds = this.accessLifetimeSeconds,
  ) {
    const family: Family = {
      id: this.families.length + 1,
      organizationId,
      scope,
      revoked: false,
      deviceName: undefined,
    };
    this.families.push(family);
    return { family, ...this.mint(family, lifetimeSeconds) };
  }

  /** An SSO record of a fresh family, for a test to seed a profile with. */
  record(options: {
    organizationId?: string;
    scope?: "read" | "read_write";
    lifetimeSeconds?: number;
    now?: number;
  }): SsoRecord {
    const issued = this.issue(
      options.organizationId ?? "org-a",
      options.scope ?? "read_write",
      options.lifetimeSeconds,
    );
    return {
      signInId: randomBytes(8).toString("hex"),
      issuer: this.issuer,
      clientId: "lazco-cli",
      organizationId: issued.family.organizationId,
      scope: issued.family.scope,
      accessToken: issued.accessToken,
      accessTokenExpiresAt:
        (options.now ?? Date.now()) +
        (options.lifetimeSeconds ?? this.accessLifetimeSeconds) * 1000,
      refreshToken: issued.refreshToken,
    };
  }

  /** Writes a config whose one profile holds an SSO sign-in in the file store. */
  async seedFileProfile(configPath: string, profile: string, sso: SsoRecord): Promise<void> {
    await writeConfig(configPath, {
      version: 1,
      currentProfile: profile,
      profiles: {
        [profile]: {
          apiUrl: this.apiUrl,
          organization: {
            id: sso.organizationId,
            name: ORGANIZATIONS[sso.organizationId] ?? "?",
          },
          method: "sso",
          credential: { store: "file", sso },
        },
      },
    });
  }

  /** The browser of a person: opens the authorize URL and follows its redirect to the CLI. */
  readonly openBrowser = async (url: string): Promise<boolean> => {
    void this.follow(url);
    return true;
  };

  private async follow(url: string): Promise<void> {
    const answer = await fetch(url, { redirect: "manual" });
    const location = answer.headers.get("location");
    if (location) {
      await fetch(location).catch(() => undefined);
    }
  }

  /** Every token this provider has issued, which no output may hold. */
  issuedTokens(): string[] {
    return [...this.accessTokens.keys(), ...this.refreshTokens.keys()];
  }

  /** True when the bearer is an access token this provider issued, alive or not. */
  isAccessToken(bearer: string): boolean {
    return this.accessTokens.has(bearer);
  }

  private mint(family: Family, lifetimeSeconds = this.accessLifetimeSeconds) {
    const accessToken = randomBytes(32).toString("hex");
    const refreshToken = randomBytes(32).toString("base64url");
    this.accessTokens.set(accessToken, { family, expiresAt: Date.now() + lifetimeSeconds * 1000 });
    this.refreshTokens.set(refreshToken, { family, rotated: false });
    return { accessToken, refreshToken };
  }

  private tokenAnswer(family: Family, withIdToken: boolean): Response {
    const pair = this.mint(family);
    return json(200, {
      access_token: pair.accessToken,
      token_type: "Bearer",
      expires_in: this.accessLifetimeSeconds,
      refresh_token: pair.refreshToken,
      scope: grantedScope(family.scope),
      ...(withIdToken ? { id_token: "header.payload.signature" } : {}),
    });
  }

  private newFamily(organizationId: string, scope: "read" | "read_write", deviceName?: string) {
    const family: Family = {
      id: this.families.length + 1,
      organizationId,
      scope,
      revoked: false,
      deviceName,
    };
    this.families.push(family);
    return family;
  }

  private async handle(request: RecordedRequest): Promise<Response> {
    const form = (request.body ?? {}) as Record<string, string>;
    switch (`${request.method} ${request.path}`) {
      case "GET /v1/oidc/openid-configuration":
        return json(200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.api.origin}/oauth/authorize`,
          token_endpoint: `${this.apiUrl}/oidc/token`,
          device_authorization_endpoint: `${this.apiUrl}/oidc/device_authorization`,
          revocation_endpoint: `${this.apiUrl}/oidc/revoke`,
        });
      case "GET /oauth/authorize":
        return this.authorize(new URL(`${this.api.origin}${request.path}${request.search}`));
      case "POST /v1/oidc/device_authorization":
        if (form.client_id !== "lazco-cli") {
          return oauthError("invalid_client", 401);
        }
        this.deviceRequest = { scope: scopeOf(form.scope), hint: form.organization_hint };
        return json(200, {
          device_code: "device-code-secret",
          user_code: "BCDF-GHJK",
          verification_uri: `${this.issuer}/device`,
          expires_in: 600,
          interval: 5,
        });
      case "POST /v1/oidc/token":
        return this.token(form);
      case "POST /v1/oidc/revoke": {
        this.revoked.push(form.token as string);
        const refresh = this.refreshTokens.get(form.token as string);
        if (refresh) {
          refresh.family.revoked = true;
        }
        return new Response(null, { status: 200 });
      }
      case "GET /v1/whoami":
        return this.whoami(request);
      default:
        return this.fallback?.(request) ?? json(404, { error: "Not found", code: "NOT_FOUND" });
    }
  }

  private authorize(url: URL): Response {
    this.authorizeUrls.push(url);
    const params = url.searchParams;
    const redirect = new URL(params.get("redirect_uri") as string);
    if (this.browser === "never-return") {
      return new Response("consent screen", { status: 200 });
    }
    const state = this.browser === "forge-state" ? "forged" : (params.get("state") as string);
    redirect.searchParams.set("state", state);
    if (this.browser !== "no-iss") {
      redirect.searchParams.set(
        "iss",
        this.browser === "wrong-iss" ? "https://evil.example" : this.issuer,
      );
    }
    if (this.browser === "deny") {
      redirect.searchParams.set("error", "access_denied");
    } else {
      const code = randomBytes(16).toString("hex");
      this.codes.set(code, {
        redirectUri: params.get("redirect_uri") as string,
        challenge: params.get("code_challenge") as string,
        scope: scopeOf(params.get("scope") ?? undefined),
        organizationId: this.pick ?? params.get("organization_hint") ?? "org-a",
      });
      redirect.searchParams.set("code", code);
    }
    return new Response(null, { status: 302, headers: { location: redirect.href } });
  }

  private async token(form: Record<string, string>): Promise<Response> {
    if (form.client_id !== "lazco-cli" || form.client_secret !== undefined) {
      return oauthError("invalid_client", 401);
    }
    switch (form.grant_type) {
      case "authorization_code": {
        const pending = this.codes.get(form.code as string);
        this.codes.delete(form.code as string);
        const verifierMatches =
          pending !== undefined &&
          createHash("sha256")
            .update(form.code_verifier ?? "")
            .digest("base64url") === pending.challenge;
        if (!pending || pending.redirectUri !== form.redirect_uri || !verifierMatches) {
          return oauthError("invalid_grant");
        }
        const family = this.newFamily(pending.organizationId, pending.scope, form.device_name);
        return this.tokenAnswer(family, true);
      }
      case "urn:ietf:params:oauth:grant-type:device_code": {
        if (form.device_code !== "device-code-secret" || !this.deviceRequest) {
          return oauthError("expired_token");
        }
        const next = this.deviceAnswers.shift() ?? "expired_token";
        if (next === "rate-limited") {
          return json(429, { error: "Too many requests", code: "RATE_LIMITED", timestamp: "t" });
        }
        if (next === "pending-forever") {
          this.deviceAnswers.unshift(next);
          return oauthError("authorization_pending");
        }
        if (next !== "approve") {
          return oauthError(next);
        }
        const family = this.newFamily(
          this.pick ?? this.deviceRequest.hint ?? "org-a",
          this.deviceRequest.scope,
        );
        this.deviceRequest = undefined;
        return this.tokenAnswer(family, true);
      }
      case "refresh_token": {
        if (this.refreshDelayMs > 0) {
          await Bun.sleep(this.refreshDelayMs);
        }
        const refresh = this.refreshTokens.get(form.refresh_token as string);
        if (!refresh || refresh.rotated || refresh.family.revoked) {
          if (refresh) {
            refresh.family.revoked = true;
          }
          return oauthError("invalid_grant");
        }
        refresh.rotated = true;
        return this.tokenAnswer(refresh.family, false);
      }
      default:
        return oauthError("unsupported_grant_type");
    }
  }

  private whoami(request: RecordedRequest): Response {
    if (this.refuseWhoami) {
      return json(403, { error: "No access", code: "ORG_ACCESS_DENIED", timestamp: "t" });
    }
    const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    const issued = this.accessTokens.get(bearer);
    if (
      !issued ||
      issued.family.revoked ||
      issued.expiresAt <= Date.now() ||
      this.rejectedAccessTokens.has(bearer)
    ) {
      return json(401, { error: "Invalid token", code: "UNAUTHORIZED", timestamp: "t" });
    }
    const organizationId = issued.family.organizationId;
    return json(200, {
      organization: { id: organizationId, name: ORGANIZATIONS[organizationId] ?? "?" },
      role: "owner",
      principal: {
        kind: "product_session",
        clientId: "lazco-cli",
        scope: issued.family.scope,
        expiresAt: new Date(issued.expiresAt).toISOString(),
      },
      features: {},
    });
  }
}
