import { type Profile, profileOf, readConfig, updateConfig } from "../config/configFile";
import { CliError } from "../core/errors";
import type { ApiClient } from "../core/request/client";
import { type Clock, SYSTEM_CLOCK } from "../core/request/clock";
import { CLI_CLIENT_ID, postOAuthForm, readProvider, readTokenAnswer } from "../sso/oauth";
import type { Credential } from "./credential";
import type { Keychain } from "./keychain";
import { withProfileLock } from "./lock";
import type { SsoRecord } from "./ssoRecord";
import { forgetCredential, loadCredential, replaceKeychainRecord } from "./store";

/** An access token that expires within this is refreshed before a request. */
export const REFRESH_MARGIN_MS = 60_000;

export type SsoCredentialOptions = {
  profileName: string;
  configPath: string;
  keychain: Keychain;
  /** The profile's API URL, whose discovery document names the token endpoint. */
  apiUrl: string;
  record: SsoRecord;
  /** A client for a full URL, without a credential. */
  client: (url: string) => ApiClient;
  /** Wall-clock time, because the expiry is stored and read by other processes. */
  clock?: Clock;
  /** Keeps each token out of every output as soon as the process holds it. */
  onSecret: (value: string) => void;
  lockWaitMs?: number;
};

/** The sign-in of a profile, read again from its store. */
type Stored = { profile: Profile; record: SsoRecord };

/**
 * The credential of an SSO profile. It refreshes the access token before a
 * request when the token expires within 60 seconds, and once after a 401,
 * under the profile's file lock, so parallel processes of one profile make
 * one refresh between them.
 */
export class SsoCredential implements Credential {
  readonly cacheKey: string;
  private readonly options: SsoCredentialOptions;
  private readonly clock: Clock;
  private record: SsoRecord;
  private readonly seen = new Set<string>();
  private pending: Promise<SsoRecord> | undefined;

  constructor(options: SsoCredentialOptions) {
    this.options = options;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.record = options.record;
    // One sign-in keeps its id across refreshes, so its cache entries do too.
    this.cacheKey = `sso:${options.record.signInId}`;
    this.remember(options.record);
  }

  secrets(): readonly string[] {
    return [...this.seen];
  }

  async bearer(): Promise<string> {
    return (await this.current(undefined)).accessToken;
  }

  async renewAfterUnauthorized(rejected: string): Promise<string | undefined> {
    const record = await this.current(rejected);
    return record.accessToken === rejected ? undefined : record.accessToken;
  }

  /** A record whose access token is not `rejected` and is not about to expire. */
  private usable(record: SsoRecord, rejected: string | undefined): boolean {
    return (
      record.accessToken !== rejected &&
      record.accessTokenExpiresAt - this.clock.now() > REFRESH_MARGIN_MS
    );
  }

  private async current(rejected: string | undefined): Promise<SsoRecord> {
    // A call that comes while another one of this process refreshes takes that
    // refresh's outcome, its error included, instead of starting one more.
    const inFlight = this.pending;
    if (inFlight !== undefined) {
      await inFlight;
      return this.current(rejected);
    }
    if (this.usable(this.record, rejected)) {
      return this.record;
    }
    this.pending = withProfileLock(
      {
        configPath: this.options.configPath,
        profileName: this.options.profileName,
        waitMs: this.options.lockWaitMs,
      },
      () => this.refreshUnderLock(rejected),
    );
    try {
      this.record = await this.pending;
      return this.record;
    } finally {
      this.pending = undefined;
    }
  }

  private remember(record: SsoRecord): void {
    for (const value of [record.accessToken, record.refreshToken]) {
      this.seen.add(value);
      this.options.onSecret(value);
    }
  }

  /** The profile's sign-in as its store holds it now, which another process may have refreshed. */
  private async readStored(): Promise<Stored> {
    const { profileName, configPath, keychain } = this.options;
    const profile = profileOf(await readConfig(configPath), profileName);
    if (profile?.method !== "sso") {
      throw new CliError(
        "CLI_NOT_LOGGED_IN",
        `Profile ${profileName} is no longer signed in, because another lazco process signed it out or its sign-in ended: run lazco auth login --sso --profile ${profileName}`,
      );
    }
    const secret = await loadCredential(keychain, profileName, "sso", profile.credential);
    const record = (secret as { sso: SsoRecord }).sso;
    if (record.signInId !== this.record.signInId) {
      throw new CliError(
        "CLI_NOT_LOGGED_IN",
        `Profile ${profileName} was signed in again by another lazco process: run the command again, or restart lazco mcp`,
      );
    }
    return { profile, record };
  }

  private async refreshUnderLock(rejected: string | undefined): Promise<SsoRecord> {
    const stored = await this.readStored();
    this.remember(stored.record);
    if (this.usable(stored.record, rejected)) {
      return stored.record;
    }
    const provider = await readProvider(this.options.client(this.options.apiUrl));
    if (provider.issuer !== stored.record.issuer) {
      throw new CliError(
        "CLI_BAD_RESPONSE",
        `The API now names the issuer ${provider.issuer}, not ${stored.record.issuer} of this sign-in`,
      );
    }
    const answer = await postOAuthForm(this.options.client, provider.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: stored.record.refreshToken,
      client_id: CLI_CLIENT_ID,
    });
    if (!answer.ok) {
      if (answer.error === "invalid_grant") {
        const leftover = await this.forget(stored.profile);
        const name = this.options.profileName;
        throw new CliError(
          "CLI_NOT_LOGGED_IN",
          `The SSO sign-in of profile ${name} has ended, so its credential is deleted${leftover === undefined ? "" : `, except the keychain entry ${leftover}, which holds dead tokens and which the OS's keychain tool can delete`}: sign in again with lazco auth login --sso --profile ${name}`,
          { oauthError: answer.error },
        );
      }
      throw new CliError(
        "CLI_BAD_RESPONSE",
        `The token endpoint refused the refresh: ${answer.error}`,
        { oauthError: answer.error },
      );
    }
    const tokens = readTokenAnswer(answer.body);
    const record: SsoRecord = {
      ...stored.record,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: this.clock.now() + tokens.expiresInSeconds * 1000,
    };
    this.remember(record);
    await this.store(stored.profile, record);
    return record;
  }

  /**
   * Stores the new pair before the lock is released, so the next process
   * reads it. When it cannot be stored, the old refresh token works for 30
   * seconds more and is then reuse, so the user must sign in again.
   */
  private async store(profile: Profile, record: SsoRecord): Promise<void> {
    const { profileName, configPath, keychain } = this.options;
    try {
      if (profile.credential.store === "keychain") {
        await replaceKeychainRecord(keychain, profileName, profile.credential.account, record);
        return;
      }
      await updateConfig(configPath, (config) => {
        const current = profileOf(config, profileName);
        if (
          current?.credential.store !== "file" ||
          current.credential.sso?.signInId !== record.signInId
        ) {
          throw new CliError(
            "CLI_INTERNAL",
            `Profile ${profileName} changed while its sign-in was refreshed`,
          );
        }
        current.credential = { store: "file", sso: record };
      });
    } catch (error) {
      const failure =
        error instanceof CliError
          ? error
          : new CliError("CLI_INTERNAL", error instanceof Error ? error.message : String(error));
      throw new CliError(
        failure.code,
        `${failure.message}. Sign in again with lazco auth login --sso --profile ${profileName}`,
        failure.details,
      );
    }
  }

  /**
   * Deletes the stored credential and the profile of an ended sign-in. Returns
   * the keychain account that could not be deleted, if any, for the error to name.
   */
  private async forget(profile: Profile): Promise<string | undefined> {
    const { profileName, configPath, keychain } = this.options;
    // The provider ended the sign-in, so an entry left behind holds dead tokens only.
    const leftover = await forgetCredential(keychain, profileName, profile.credential).then(
      () => undefined,
      () => (profile.credential.store === "keychain" ? profile.credential.account : undefined),
    );
    await updateConfig(configPath, (config) => {
      delete config.profiles[profileName];
      if (config.currentProfile === profileName) {
        delete config.currentProfile;
      }
    });
    return leftover;
  }
}
