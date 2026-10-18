import { z } from "zod";
import { CliError } from "../core/errors";
import { type ApiClient, mapErrorResponse, requireJson } from "../core/request/client";

/** The public OAuth client of the CLI. It holds no secret. */
export const CLI_CLIENT_ID = "lazco-cli";

const LOCAL_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

const endpoint = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
}, "must use https://");

const discoverySchema = z.looseObject({
  issuer: endpoint,
  authorization_endpoint: endpoint,
  token_endpoint: endpoint,
  device_authorization_endpoint: endpoint,
  revocation_endpoint: endpoint,
});

/** The endpoints of the API's OpenID provider. */
export type Provider = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint: string;
  revocationEndpoint: string;
};

/**
 * Reads the discovery document of the API in use, `<api url>/oidc/openid-configuration`,
 * so `--api-url` also picks the provider.
 */
export async function readProvider(apiClient: ApiClient): Promise<Provider> {
  const response = await apiClient.call({
    method: "GET",
    path: "/oidc/openid-configuration",
    authenticate: false,
  });
  const parsed = discoverySchema.safeParse(requireJson(response));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CliError(
      "CLI_BAD_RESPONSE",
      `The API's OpenID discovery document is not usable: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim(),
      { url: apiClient.url({ path: "/oidc/openid-configuration" }) },
    );
  }
  const document = parsed.data;
  return {
    issuer: document.issuer,
    authorizationEndpoint: document.authorization_endpoint,
    tokenEndpoint: document.token_endpoint,
    deviceAuthorizationEndpoint: document.device_authorization_endpoint,
    revocationEndpoint: document.revocation_endpoint,
  };
}

/** The answer of an OAuth endpoint: its JSON body, or an OAuth error (RFC 6749 section 5.2). */
export type OAuthAnswer =
  | { ok: true; body: unknown }
  | { ok: false; error: string; description: string | undefined };

/**
 * Posts a form to an OAuth endpoint, a full URL, without a bearer. An error
 * with the OAuth body is returned. Any other error answer is thrown as
 * `cli-core` maps it, such as a 429 of the rate limiter.
 */
export async function postOAuthForm(
  client: (url: string) => ApiClient,
  url: string,
  form: Record<string, string>,
): Promise<OAuthAnswer> {
  const response = await client(url).send({
    method: "POST",
    path: "",
    form,
    authenticate: false,
  });
  if (response.status >= 200 && response.status < 300) {
    return { ok: true, body: requireJson(response) };
  }
  const body = response.body as { error?: unknown; error_description?: unknown } | null;
  if ((response.status === 400 || response.status === 401) && typeof body?.error === "string") {
    return {
      ok: false,
      error: body.error,
      description: typeof body?.error_description === "string" ? body.error_description : undefined,
    };
  }
  throw mapErrorResponse(response);
}

const tokenAnswerSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().nonnegative(),
  refresh_token: z.string().min(1),
  scope: z.string(),
});

/** The tokens of a sign-in or a refresh. */
export type TokenAnswer = {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scope: string;
};

/** The tokens of a 200 of the token endpoint, or `CLI_BAD_RESPONSE`. */
export function readTokenAnswer(body: unknown): TokenAnswer {
  const parsed = tokenAnswerSchema.safeParse(body);
  if (!parsed.success) {
    throw new CliError("CLI_BAD_RESPONSE", "The token endpoint answered without a usable token", {
      problem: parsed.error.issues[0]?.path.join(".") ?? "",
    });
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresInSeconds: parsed.data.expires_in,
    scope: parsed.data.scope,
  };
}

/** A sign-in that the provider ended, such as `access_denied`. */
export function signInRefused(
  error: string,
  description: string | undefined,
  message: string,
): CliError {
  return new CliError("CLI_NOT_LOGGED_IN", message, {
    oauthError: error,
    ...(description ? { description } : {}),
  });
}

/**
 * Revokes an SSO sign-in at the provider with its refresh token, which works
 * after the access token has expired. Revoking ends the whole sign-in.
 */
export async function revokeSignIn(
  client: (url: string) => ApiClient,
  apiUrl: string,
  refreshToken: string,
): Promise<void> {
  const provider = await readProvider(client(apiUrl));
  const answer = await postOAuthForm(client, provider.revocationEndpoint, {
    token: refreshToken,
    token_type_hint: "refresh_token",
    client_id: CLI_CLIENT_ID,
  });
  if (!answer.ok) {
    throw new CliError(
      "CLI_BAD_RESPONSE",
      `The revocation endpoint refused the request: ${answer.error}`,
      { oauthError: answer.error },
    );
  }
}
