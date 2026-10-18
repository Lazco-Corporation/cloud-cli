/**
 * The credential a client sends: a fixed API token, or an SSO sign-in whose
 * access token is refreshed while the process runs.
 */
export type Credential = {
  /** A value that names this credential for a cache, stable while the sign-in lasts. It is hashed before use and never sent. */
  readonly cacheKey: string;
  /** The bearer of the next request. */
  bearer(): Promise<string>;
  /**
   * Called once after the API answered 401 to `rejected`. Returns the bearer
   * to send the request with once more, or `undefined` when there is none.
   */
  renewAfterUnauthorized(rejected: string): Promise<string | undefined>;
  /** Every secret value this credential has held, so no output ever shows one. */
  secrets(): readonly string[];
};

/** A credential that never changes: an API token. */
export function staticCredential(token: string): Credential {
  return {
    cacheKey: token,
    bearer: async () => token,
    renewAfterUnauthorized: async () => undefined,
    secrets: () => [token],
  };
}
