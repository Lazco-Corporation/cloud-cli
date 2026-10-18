import {
  checkProfileName,
  DEFAULT_PROFILE,
  type Profile,
  profileOf,
  readConfig,
  type SignInMethod,
  updateConfig,
} from "../config/configFile";
import { ApiError, CliError, toToolError } from "../core/errors";
import { requireJson } from "../core/request/client";
import { staticCredential } from "../credentials/credential";
import { withProfileLock } from "../credentials/lock";
import { grantedScope, newSignInId, type SsoRecord } from "../credentials/ssoRecord";
import {
  forgetCredential,
  loadCredential,
  type Secret,
  storeCredential,
} from "../credentials/store";
import { DEFAULT_API_URL } from "../shell/apiUrl";
import { ask } from "../shell/confirm";
import { readHidden } from "../shell/hiddenPrompt";
import { canPrompt, readAll } from "../shell/io";
import { writeNotice } from "../shell/output";
import { CLI_CLIENT_ID, revokeSignIn } from "../sso/oauth";
import { signInWithSso } from "../sso/signIn";
import type { HandwrittenCommand, HandwrittenContext } from "./types";

/** An API token: `API_TOKEN_PREFIX` of the backend and 32 random bytes in hex. */
const API_TOKEN_FORMAT = /^lz_live_[0-9a-f]{64}$/;

const NO_INPUT = { type: "object", properties: {}, additionalProperties: false };

/** The login inputs that only an SSO sign-in takes, with their flags. */
const SSO_OPTIONS = [
  ["device", "--device"],
  ["org", "--org"],
  ["readOnly", "--read-only"],
  ["switch", "--switch"],
] as const;

/** Where a sign-in that cannot be revoked now stays visible, and for how long. */
const STILL_LISTED =
  "it stays listed in the signed-in products of the Cloud settings until it is revoked there or unused for 30 days";

/** The profile a login writes or a logout forgets, when `--profile` and `LAZCO_PROFILE` name none. */
function namedProfile(context: HandwrittenContext): string | undefined {
  if (context.flags.profile !== undefined) {
    return context.flags.profile;
  }
  const fromEnvironment = context.io.env.LAZCO_PROFILE;
  return fromEnvironment ? checkProfileName(fromEnvironment, "LAZCO_PROFILE") : undefined;
}

/** The Cloud panel of an API, such as `https://cloud-staging.lazco.tw` for `api-staging.lazco.tw`. */
export function panelUrl(apiUrl: string): string | undefined {
  const match = /^api(-[a-z0-9-]+)?\.lazco\.tw$/.exec(new URL(apiUrl).hostname);
  return match ? `https://cloud${match[1] ?? ""}.lazco.tw` : undefined;
}

function invalid(message: string, field: string, problem: string): CliError {
  return new CliError("CLI_INVALID_INPUT", message, [{ field, message: problem }]);
}

/**
 * The method of a login: `--sso` or an SSO option, `--with-token`, or the
 * answer on a terminal. Refuses a combination that cannot both apply.
 */
async function chooseMethod(
  input: Record<string, unknown>,
  context: HandwrittenContext,
): Promise<SignInMethod> {
  const ssoOptions = SSO_OPTIONS.filter(
    ([property]) => input[property] !== undefined && input[property] !== false,
  );
  if (input.sso === true && input.withToken === true) {
    throw invalid(
      "--sso and --with-token cannot both be given",
      "sso",
      "conflicts with --with-token",
    );
  }
  if (input.withToken === true && ssoOptions.length > 0) {
    const flag = (ssoOptions[0] as (typeof SSO_OPTIONS)[number])[1];
    throw invalid(
      `${flag} is an option of the SSO sign-in, so it cannot go with --with-token`,
      flag.slice(2),
      "needs the SSO sign-in",
    );
  }
  if (input.switch === true && input.org !== undefined) {
    throw invalid(
      "--switch and --org cannot both be given: --switch lets you pick the organization again",
      "switch",
      "conflicts with --org",
    );
  }
  if (input.sso === true || ssoOptions.length > 0) {
    return "sso";
  }
  if (input.withToken === true) {
    return "token";
  }
  if (!canPrompt(context.io)) {
    throw new CliError(
      "CLI_INVALID_INPUT",
      "There is no terminal to ask on: give --sso to sign in with the browser, or pipe an API token into --with-token",
      [
        { field: "sso", message: "signs in with the browser" },
        { field: "with-token", message: "reads an API token from stdin" },
      ],
    );
  }
  const answer = await ask(
    context.io,
    "How do you want to sign in?\n  1. Sign in with your browser\n  2. Paste an API token\nChoose 1 or 2: ",
  );
  if (answer === "1") {
    return "sso";
  }
  if (answer === "2") {
    return "token";
  }
  throw invalid("Choose 1 or 2", "method", "must be 1 or 2");
}

async function readToken(input: Record<string, unknown>, context: HandwrittenContext) {
  if (input.withToken === true) {
    return (await readAll(context.io.stdin)).trim();
  }
  return (await readHidden(context.io, "Paste a Lazco API token (hidden): ")).trim();
}

function checkTokenFormat(token: string): void {
  if (API_TOKEN_FORMAT.test(token)) {
    return;
  }
  const message = token.startsWith("lz_admin_")
    ? "is an admin key, which cannot sign in the CLI"
    : "must be lz_live_ followed by 64 lowercase hexadecimal characters";
  throw new CliError("CLI_INVALID_INPUT", `The token is not a Lazco API token: it ${message}`, [
    { field: "token", message },
  ]);
}

type Whoami = { organization: Profile["organization"]; scope: string | null };

function readWhoami(whoami: unknown): Whoami {
  const value = whoami as {
    organization?: { id?: unknown; name?: unknown };
    principal?: { scope?: unknown };
  } | null;
  const organization = value?.organization;
  if (typeof organization?.id !== "string" || typeof organization.name !== "string") {
    throw new CliError("CLI_BAD_RESPONSE", "GET /whoami answered without the organization");
  }
  const scope = value?.principal?.scope;
  return {
    organization: { id: organization.id, name: organization.name },
    scope: typeof scope === "string" ? scope : null,
  };
}

/** Reads `whoami` with a new credential, which login stores only when this answers 200. */
async function checkCredential(
  context: HandwrittenContext,
  apiUrl: string,
  bearer: string,
): Promise<Whoami> {
  return readWhoami(
    requireJson(
      await context
        .client(apiUrl, staticCredential(bearer))
        .call({ method: "GET", path: "/whoami" }),
    ),
  );
}

/** The client for a full URL without a credential, as the OAuth endpoints take it. */
function oauthClient(context: HandwrittenContext) {
  return (url: string) => context.client(url, undefined);
}

/**
 * Revokes an SSO sign-in that this run no longer keeps, and says on stderr
 * when that fails, because the sign-in then stays in the user's list.
 */
async function revokeOrWarn(
  context: HandwrittenContext,
  apiUrl: string,
  refreshToken: string,
  which: string,
): Promise<void> {
  context.addSecret(refreshToken);
  await revokeSignIn(oauthClient(context), apiUrl, refreshToken).catch((error: unknown) => {
    // The OAuth client holds no credential to redact, and the API's text may echo the token.
    writeNotice(
      context.io,
      context.redact(
        `warning: ${which} could not be revoked (${toToolError(error).message}), so ${STILL_LISTED}`,
      ),
    );
  });
}

/** A token sign-in: the pasted token, checked. */
async function tokenSignIn(
  input: Record<string, unknown>,
  context: HandwrittenContext,
  apiUrl: string,
): Promise<{ secret: Secret; whoami: Whoami }> {
  const token = await readToken(input, context);
  context.addSecret(token);
  checkTokenFormat(token);
  const whoami = await checkCredential(context, apiUrl, token);
  return { secret: { method: "token", token }, whoami };
}

/**
 * An SSO sign-in: the loopback or device flow, then `whoami` with the new
 * access token. A sign-in that `whoami` refuses is revoked, so it is not
 * left behind in the user's list.
 */
async function ssoSignIn(
  input: Record<string, unknown>,
  context: HandwrittenContext,
  apiUrl: string,
  previous: Profile | undefined,
): Promise<{ secret: Secret; whoami: Whoami }> {
  const keepsOrganization =
    input.switch !== true && previous?.method === "sso" && previous.apiUrl === apiUrl;
  const organizationHint =
    typeof input.org === "string"
      ? input.org
      : keepsOrganization
        ? previous.organization.id
        : undefined;
  const { provider, tokens } = await signInWithSso(
    {
      apiUrl,
      organizationHint,
      readOnly: input.readOnly === true,
      device: input.device === true,
    },
    {
      io: context.io,
      platform: context.paths.platform,
      clock: context.clock,
      client: oauthClient(context),
      openBrowser: (url) => context.openBrowser(url),
      loopbackTimeoutMs: context.loopbackTimeoutMs,
      addSecret: (value) => context.addSecret(value),
    },
  );
  const unkept = "the new SSO sign-in, which is not stored,";
  let whoami: Whoami;
  try {
    whoami = await checkCredential(context, apiUrl, tokens.accessToken);
  } catch (error) {
    await revokeOrWarn(context, apiUrl, tokens.refreshToken, unkept);
    throw error;
  }
  const scope = grantedScope(tokens.scope);
  if (scope === undefined) {
    await revokeOrWarn(context, apiUrl, tokens.refreshToken, unkept);
    throw new CliError("CLI_BAD_RESPONSE", "The token endpoint granted neither read nor write", {
      scope: tokens.scope,
    });
  }
  const sso: SsoRecord = {
    signInId: newSignInId(),
    issuer: provider.issuer,
    clientId: CLI_CLIENT_ID,
    organizationId: whoami.organization.id,
    scope,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: context.clock.now() + tokens.expiresInSeconds * 1000,
    refreshToken: tokens.refreshToken,
  };
  return { secret: { method: "sso", sso }, whoami };
}

/**
 * The refresh token of a profile's SSO sign-in, or `undefined` when there is
 * none to revoke, a keychain entry that is already gone among them.
 */
async function storedRefreshToken(
  context: HandwrittenContext,
  name: string,
  profile: Profile,
): Promise<string | undefined> {
  if (profile.method !== "sso") {
    return undefined;
  }
  let secret: Secret;
  try {
    secret = await loadCredential(context.keychain, name, "sso", profile.credential);
  } catch (error) {
    if (error instanceof CliError && error.code === "CLI_NOT_LOGGED_IN") {
      return undefined;
    }
    throw error;
  }
  if (secret.method !== "sso") {
    return undefined;
  }
  context.addSecret(secret.sso.accessToken);
  context.addSecret(secret.sso.refreshToken);
  return secret.sso.refreshToken;
}

/**
 * Stores a checked credential as the profile, under the profile's lock, and
 * deletes the entry of the login it replaces. Returns what that login was,
 * with its refresh token when it was an SSO sign-in, so it can be revoked.
 */
async function keep(
  context: HandwrittenContext,
  name: string,
  profile: { apiUrl: string; organization: Profile["organization"]; method: SignInMethod },
  secret: Secret,
) {
  return withProfileLock({ configPath: context.configPath, profileName: name }, async () => {
    // Only a holder of this lock changes the profile, so the read is current. The keychain is
    // read before the config lock is taken, so a keychain prompt never holds up other profiles.
    const previous = profileOf(await readConfig(context.configPath), name);
    const previousRefreshToken = previous
      ? await storedRefreshToken(context, name, previous).catch((error: unknown) => {
          writeNotice(
            context.io,
            context.redact(
              `warning: the previous SSO sign-in of profile ${name} could not be read (${toToolError(error).message}), so it is not revoked and ${STILL_LISTED}`,
            ),
          );
          return undefined;
        })
      : undefined;
    const { credential, keychainError } = await storeCredential(context.keychain, name, secret);
    const current = await updateConfig(context.configPath, (config) => {
      config.profiles[name] = { ...profile, credential };
      config.currentProfile ??= name;
      return config.currentProfile === name;
    }).catch(async (error: unknown) => {
      // The old config still names the old entry, so the new one serves nobody.
      await forgetCredential(context.keychain, name, credential).catch(() => undefined);
      throw error;
    });
    // Only now that the config names the new entry is the old one unused.
    if (previous) {
      await forgetCredential(context.keychain, name, previous.credential).catch(() => {
        if (previous.credential.store === "keychain") {
          writeNotice(
            context.io,
            `warning: the keychain entry ${previous.credential.account} of the previous login could not be deleted. Delete it with the OS's keychain tool, see https://github.com/Lazco-Corporation/cloud-cli/blob/main/docs/credentials.md`,
          );
        }
      });
    }
    return { credential, keychainError, current, previous, previousRefreshToken };
  });
}

const login: HandwrittenCommand = {
  command: ["auth", "login"],
  summary: "Sign in with your Lazco account, or with a Lazco API token",
  description:
    "On a terminal it asks how to sign in. --sso signs in with your Lazco account in a browser: on this machine, or with a code on another device with --device, over SSH, or on Linux without a display. --with-token reads an API token from stdin. The credential is checked with GET /whoami and stored in the OS keychain, or in the config file with mode 0600 when there is no keychain. --profile names the profile (default: default), and --api-url its API.",
  kind: "write",
  positionals: [],
  inputSchema: {
    type: "object",
    properties: {
      sso: { type: "boolean", description: "Sign in with your Lazco account in a browser" },
      withToken: { type: "boolean", description: "Read an API token from stdin instead of asking" },
      device: {
        type: "boolean",
        description: "Sign in with a code on another device, with no browser on this machine",
      },
      org: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description: "The organization id to preselect on the consent screen",
      },
      readOnly: { type: "boolean", description: "Ask for read-only access" },
      switch: {
        type: "boolean",
        description: "Pick the organization again, and revoke the profile's previous sign-in",
      },
    },
    additionalProperties: false,
  },
  async run(input, context) {
    const name = namedProfile(context) ?? DEFAULT_PROFILE;
    const method = await chooseMethod(input, context);
    const before = profileOf(await readConfig(context.configPath), name);
    const apiUrl = context.flags.apiUrl ?? before?.apiUrl ?? DEFAULT_API_URL;
    const { secret, whoami } =
      method === "token"
        ? await tokenSignIn(input, context, apiUrl)
        : await ssoSignIn(input, context, apiUrl, before);
    const organization = whoami.organization;

    let stored: Awaited<ReturnType<typeof keep>>;
    try {
      stored = await keep(context, name, { apiUrl, organization, method }, secret);
    } catch (error) {
      // Nothing stores the new SSO sign-in, so it would only wait in the user's list.
      if (secret.method === "sso") {
        await revokeOrWarn(
          context,
          apiUrl,
          secret.sso.refreshToken,
          "the new SSO sign-in, which is not stored,",
        );
      }
      throw error;
    }
    const { credential, keychainError, current, previous, previousRefreshToken } = stored;

    // A replaced SSO sign-in is revoked. A replaced API token is not, because the panel manages it.
    if (previous && previousRefreshToken !== undefined) {
      await revokeOrWarn(
        context,
        previous.apiUrl,
        previousRefreshToken,
        `the previous SSO sign-in of profile ${name}`,
      );
    }
    if (keychainError !== undefined) {
      writeNotice(
        context.io,
        `warning: no keychain was found (${keychainError}), so the credential is stored in ${context.configPath} with mode 0600`,
      );
    }
    if (previous && previous.organization.id !== organization.id) {
      writeNotice(
        context.io,
        `profile ${name} now signs in to ${organization.name}, not ${previous.organization.name}`,
      );
    }
    return {
      record: {
        profile: name,
        method,
        apiUrl,
        organization,
        scope: whoami.scope,
        store: credential.store,
        ...(credential.store === "file" ? { path: context.configPath } : {}),
        current,
      },
    };
  },
};

const status: HandwrittenCommand = {
  command: ["auth", "status"],
  summary: "Show the sign-in of this run",
  description:
    "Shows the profile, or env for LAZCO_TOKEN, the method (token or sso), the API URL, where the credential is stored, and from GET /whoami the organization, the role, the scope and the expiry.",
  kind: "read",
  positionals: [],
  inputSchema: NO_INPUT,
  async run(_input, context) {
    const session = await context.session();
    const credential = await context.credential();
    const whoami = requireJson(
      await context.client(session.apiUrl, credential).call({ method: "GET", path: "/whoami" }),
    ) as {
      organization?: unknown;
      role?: unknown;
      principal?: { scope?: unknown; expiresAt?: unknown };
    };
    const source = session.source;
    const store = source.kind === "profile" ? source.profile.credential.store : "env";
    return {
      record: {
        profile: source.kind === "profile" ? source.name : "env",
        method: source.kind === "profile" ? source.profile.method : "token",
        apiUrl: session.apiUrl,
        store,
        ...(store === "file" ? { path: context.configPath } : {}),
        organization: whoami.organization ?? null,
        role: whoami.role ?? null,
        scope: whoami.principal?.scope ?? null,
        expiresAt: whoami.principal?.expiresAt ?? null,
      },
    };
  },
};

const logout: HandwrittenCommand = {
  command: ["auth", "logout"],
  summary: "Sign a profile out and forget its credential",
  description:
    "Revokes an SSO sign-in at the provider, then deletes the profile's credential from its store and deletes the profile. A pasted API token stays valid until it is revoked on /dashboard/api of the Cloud panel.",
  kind: "write",
  positionals: [],
  inputSchema: NO_INPUT,
  async run(_input, context) {
    if (context.io.env.LAZCO_TOKEN && context.flags.profile === undefined) {
      throw new CliError(
        "CLI_INVALID_INPUT",
        "LAZCO_TOKEN is set, so no stored credential is in use: unset it, or name the profile with --profile",
        [{ field: "profile", message: "is needed while LAZCO_TOKEN is set" }],
      );
    }
    const name = namedProfile(context) ?? (await readConfig(context.configPath)).currentProfile;
    if (name === undefined) {
      throw new CliError(
        "CLI_NOT_LOGGED_IN",
        "No profile is signed in, so there is nothing to forget",
      );
    }
    const { profile, revokeError } = await withProfileLock(
      { configPath: context.configPath, profileName: name },
      async () => {
        // Only a holder of this profile's lock changes the profile, so it stays as read here.
        const profile = profileOf(await readConfig(context.configPath), name);
        if (!profile) {
          throw new CliError(
            "CLI_INVALID_INPUT",
            `No profile is named ${name}: run lazco profile list`,
            [{ field: "profile", message: "names no profile" }],
          );
        }
        let revokeError: unknown;
        if (profile.method === "sso") {
          const refreshToken = await storedRefreshToken(context, name, profile);
          if (refreshToken !== undefined) {
            revokeError = await revokeSignIn(
              oauthClient(context),
              profile.apiUrl,
              refreshToken,
            ).then(
              () => undefined,
              (error: unknown) => error,
            );
          }
        }
        await forgetCredential(context.keychain, name, profile.credential);
        await updateConfig(context.configPath, (config) => {
          delete config.profiles[name];
          if (config.currentProfile === name) {
            delete config.currentProfile;
          }
        });
        return { profile, revokeError };
      },
    );

    if (profile.method === "sso") {
      if (revokeError !== undefined) {
        throw revokeFailure(name, revokeError);
      }
      return { record: { profile: name, loggedOut: true } };
    }
    const panel = panelUrl(profile.apiUrl);
    writeNotice(
      context.io,
      panel
        ? `the token stays valid until it is revoked at ${panel}/dashboard/api`
        : "the token stays valid until it is revoked on /dashboard/api of the Cloud panel of its API",
    );
    return { record: { profile: name, loggedOut: true } };
  },
};

/** The error of a logout whose credential is deleted but whose sign-in was not revoked. */
function revokeFailure(name: string, error: unknown): CliError | ApiError {
  const failure = toToolError(error);
  const message = `Profile ${name} and its credential are deleted, but the sign-in could not be revoked, so ${STILL_LISTED}: ${failure.message}`;
  if (failure instanceof ApiError) {
    return new ApiError(failure.status, failure.code, message, failure.fields);
  }
  return new CliError(failure.code, message, failure.details);
}

export const AUTH_COMMANDS: readonly HandwrittenCommand[] = [login, status, logout];
