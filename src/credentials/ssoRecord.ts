import { randomBytes } from "node:crypto";
import { z } from "zod";
import { CliError } from "../core/errors";

/**
 * One SSO sign-in as it is stored: the refresh token, the access token and
 * its expiry, the granted scope, and where it came from. It lives in the same
 * store as an API token, as one JSON value.
 */
export const ssoRecordSchema = z.looseObject({
  /** 16 random hexadecimal characters of one sign-in, which never change on a refresh. */
  signInId: z.string().regex(/^[0-9a-f]{16}$/),
  issuer: z.url(),
  clientId: z.string().min(1),
  organizationId: z.string().min(1),
  scope: z.enum(["read", "read_write"]),
  accessToken: z.string().min(1),
  /** Epoch milliseconds. */
  accessTokenExpiresAt: z.number().int(),
  refreshToken: z.string().min(1),
});

export type SsoRecord = z.infer<typeof ssoRecordSchema>;

export function newSignInId(): string {
  return randomBytes(8).toString("hex");
}

/** The record a keychain entry holds. A value that is not one is `CLI_INTERNAL` naming the profile. */
export function parseSsoRecord(text: string, profileName: string): SsoRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const parsed = ssoRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError(
      "CLI_INTERNAL",
      `The keychain entry of profile ${profileName} holds no valid SSO sign-in: run lazco auth login --profile ${profileName}`,
    );
  }
  return parsed.data;
}

/** The scope of a token answer, `openid lazco.read lazco.write` or `openid lazco.read`, as stored. */
export function grantedScope(scope: string): SsoRecord["scope"] | undefined {
  const scopes = scope.split(" ");
  if (scopes.includes("lazco.write")) {
    return "read_write";
  }
  return scopes.includes("lazco.read") ? "read" : undefined;
}
