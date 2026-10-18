import { checkProfileName, type Profile, readConfig } from "../config/configFile";
import { CliError } from "../core/errors";
import { DEFAULT_API_URL } from "../shell/apiUrl";
import type { Keychain } from "./keychain";
import { loadCredential } from "./store";

/** Where the credential of a command comes from. */
export type CredentialSource =
  | { kind: "env" }
  | { kind: "profile"; name: string; profile: Profile }
  | { kind: "none" };

/** The API a command talks to, and the credential it may send there. */
export type Session = {
  apiUrl: string;
  source: CredentialSource;
  /**
   * The profile's own API URL, set when `--api-url` names another one. The
   * profile's credential never goes to any URL but its own.
   */
  conflictingProfileUrl?: string;
};

/**
 * Picks the credential in the order of `cli-auth`: `LAZCO_TOKEN`, the profile
 * of `--profile`, the profile of `LAZCO_PROFILE`, then the current profile.
 * `LAZCO_TOKEN` goes to `--api-url` or the default API. A profile's
 * credential goes to the profile's API URL. The keychain is not read here.
 */
export async function resolveSession(options: {
  env: Record<string, string | undefined>;
  profileFlag: string | undefined;
  apiUrlFlag: string | undefined;
  configPath: string;
}): Promise<Session> {
  if (options.env.LAZCO_TOKEN) {
    return { apiUrl: options.apiUrlFlag ?? DEFAULT_API_URL, source: { kind: "env" } };
  }
  const named =
    options.profileFlag ??
    (options.env.LAZCO_PROFILE
      ? checkProfileName(options.env.LAZCO_PROFILE, "LAZCO_PROFILE")
      : undefined);
  const config = await readConfig(options.configPath);
  const name = named ?? config.currentProfile;
  if (name === undefined) {
    return { apiUrl: options.apiUrlFlag ?? DEFAULT_API_URL, source: { kind: "none" } };
  }
  const profile = config.profiles[name];
  if (!profile) {
    throw new CliError(
      "CLI_INVALID_INPUT",
      `No profile is named ${name}: run lazco profile list, or lazco auth login --profile ${name}`,
      [
        {
          field: options.profileFlag !== undefined ? "profile" : "LAZCO_PROFILE",
          message: "names no profile",
        },
      ],
    );
  }
  const session: Session = {
    apiUrl: options.apiUrlFlag ?? profile.apiUrl,
    source: { kind: "profile", name, profile },
  };
  if (options.apiUrlFlag !== undefined && options.apiUrlFlag !== profile.apiUrl) {
    session.conflictingProfileUrl = profile.apiUrl;
  }
  return session;
}

/**
 * The credential a request of this session carries. Throws
 * `CLI_NOT_LOGGED_IN` when there is none, and `CLI_INVALID_INPUT` when
 * `--api-url` would carry a stored credential to another API.
 */
export async function sessionCredential(
  session: Session,
  env: Record<string, string | undefined>,
  keychain: Keychain,
): Promise<string> {
  const source = session.source;
  if (source.kind === "env") {
    return env.LAZCO_TOKEN as string;
  }
  if (source.kind === "none") {
    throw new CliError(
      "CLI_NOT_LOGGED_IN",
      "Not signed in: run lazco auth login, or set LAZCO_TOKEN to a Lazco API token",
    );
  }
  if (session.conflictingProfileUrl !== undefined) {
    throw new CliError(
      "CLI_INVALID_INPUT",
      `Profile ${source.name} signs in to ${session.conflictingProfileUrl}, so its token is not sent to ${session.apiUrl}`,
      [
        {
          field: "api-url",
          message: `differs from the API URL of profile ${source.name}: use another profile, or set LAZCO_TOKEN`,
        },
      ],
    );
  }
  return loadCredential(keychain, source.name, source.profile.credential);
}
