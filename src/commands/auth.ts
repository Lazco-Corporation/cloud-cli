import {
  checkProfileName,
  DEFAULT_PROFILE,
  type Profile,
  profileOf,
  readConfig,
  writeConfig,
} from "../config/configFile";
import { CliError } from "../core/errors";
import { requireJson } from "../core/request/client";
import { forgetCredential, storeCredential } from "../credentials/store";
import { DEFAULT_API_URL } from "../shell/apiUrl";
import { readHidden } from "../shell/hiddenPrompt";
import { canPrompt, readAll } from "../shell/io";
import { writeNotice } from "../shell/output";
import type { HandwrittenCommand, HandwrittenContext } from "./types";

/** An API token: `API_TOKEN_PREFIX` of the backend and 32 random bytes in hex. */
const API_TOKEN_FORMAT = /^lz_live_[0-9a-f]{64}$/;

const NO_INPUT = { type: "object", properties: {}, additionalProperties: false };

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

async function readToken(input: Record<string, unknown>, context: HandwrittenContext) {
  if (input.withToken === true) {
    return (await readAll(context.io.stdin)).trim();
  }
  if (!canPrompt(context.io)) {
    throw new CliError(
      "CLI_INVALID_INPUT",
      "There is no terminal to ask on: pipe the token into lazco auth login --with-token",
      [{ field: "with-token", message: "is needed without a terminal" }],
    );
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

function organizationOf(whoami: unknown): Profile["organization"] {
  const organization = (whoami as { organization?: { id?: unknown; name?: unknown } } | null)
    ?.organization;
  if (typeof organization?.id !== "string" || typeof organization.name !== "string") {
    throw new CliError("CLI_BAD_RESPONSE", "GET /whoami answered without the organization");
  }
  return { id: organization.id, name: organization.name };
}

const login: HandwrittenCommand = {
  command: ["auth", "login"],
  summary: "Sign in with a Lazco API token",
  description:
    "Asks for the token with the input hidden, or reads it from stdin with --with-token. The token is checked with GET /whoami and stored in the OS keychain, or in the config file with mode 0600 when there is no keychain. --profile names the profile (default: default), and --api-url its API.",
  kind: "write",
  positionals: [],
  inputSchema: {
    type: "object",
    properties: {
      withToken: { type: "boolean", description: "Read the token from stdin instead of asking" },
    },
    additionalProperties: false,
  },
  async run(input, context) {
    const name = namedProfile(context) ?? DEFAULT_PROFILE;
    const token = await readToken(input, context);
    context.addSecret(token);
    checkTokenFormat(token);

    const config = await readConfig(context.configPath);
    const previous = profileOf(config, name);
    const apiUrl = context.flags.apiUrl ?? previous?.apiUrl ?? DEFAULT_API_URL;
    const whoami = requireJson(
      await context.client(apiUrl, token).call({ method: "GET", path: "/whoami" }),
    );
    const organization = organizationOf(whoami);

    const { credential, keychainError } = await storeCredential(context.keychain, name, token);
    if (previous?.credential.store === "keychain" && credential.store === "file") {
      await forgetCredential(context.keychain, name, previous.credential).catch(() => undefined);
    }
    config.profiles[name] = { apiUrl, organization, credential };
    config.currentProfile ??= name;
    await writeConfig(context.configPath, config);

    if (keychainError !== undefined) {
      writeNotice(
        context.io,
        `warning: no keychain was found (${keychainError}), so the token is stored in ${context.configPath} with mode 0600`,
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
        apiUrl,
        organization,
        store: credential.store,
        ...(credential.store === "file" ? { path: context.configPath } : {}),
        current: config.currentProfile === name,
      },
    };
  },
};

const status: HandwrittenCommand = {
  command: ["auth", "status"],
  summary: "Show the sign-in of this run",
  description:
    "Shows the profile, or env for LAZCO_TOKEN, the API URL, where the credential is stored, and from GET /whoami the organization, the role, the scope and the expiry.",
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
  summary: "Forget the stored credential of a profile",
  description:
    "Deletes the profile's token from its store and deletes the profile. The token stays valid until it is revoked on /dashboard/api of the Cloud panel.",
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
    const config = await readConfig(context.configPath);
    const name = namedProfile(context) ?? config.currentProfile;
    if (name === undefined) {
      throw new CliError(
        "CLI_NOT_LOGGED_IN",
        "No profile is signed in, so there is nothing to forget",
      );
    }
    const profile = profileOf(config, name);
    if (!profile) {
      throw new CliError(
        "CLI_INVALID_INPUT",
        `No profile is named ${name}: run lazco profile list`,
        [{ field: "profile", message: "names no profile" }],
      );
    }
    await forgetCredential(context.keychain, name, profile.credential);
    delete config.profiles[name];
    if (config.currentProfile === name) {
      delete config.currentProfile;
    }
    await writeConfig(context.configPath, config);

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

export const AUTH_COMMANDS: readonly HandwrittenCommand[] = [login, status, logout];
