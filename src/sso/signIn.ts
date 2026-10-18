import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import { ApiError, CliError, toToolError } from "../core/errors";
import type { ApiClient } from "../core/request/client";
import type { Clock } from "../core/request/clock";
import type { Io } from "../shell/io";
import { writeNotice } from "../shell/output";
import { startLoopback } from "./loopback";
import {
  CLI_CLIENT_ID,
  type Provider,
  postOAuthForm,
  readProvider,
  readTokenAnswer,
  signInRefused,
  type TokenAnswer,
} from "./oauth";

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** RFC 8628 section 3.5: every `slow_down` adds 5 seconds to the interval. */
export const SLOW_DOWN_STEP_MS = 5000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

export type SsoSignInContext = {
  io: Io;
  platform: NodeJS.Platform;
  clock: Clock;
  /** A client for a full URL, without a credential. */
  client: (url: string) => ApiClient;
  openBrowser: (url: string) => Promise<boolean>;
  loopbackTimeoutMs: number;
  /** Keeps a value out of every output. */
  addSecret: (value: string) => void;
};

export type SsoSignInOptions = {
  apiUrl: string;
  /** Sent as `organization_hint`, which the consent screen preselects. */
  organizationHint: string | undefined;
  readOnly: boolean;
  device: boolean;
};

export type SsoSignIn = { provider: Provider; tokens: TokenAnswer };

/** The device flow runs with `--device`, over SSH, and on a Linux host with no display. */
export function usesDeviceFlow(
  device: boolean,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): boolean {
  if (device || env.SSH_CONNECTION) {
    return true;
  }
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/** The device name the provider stores and shows: this host's name and its platform. */
export function deviceName(platform: NodeJS.Platform): string {
  const label =
    platform === "darwin"
      ? "macOS"
      : platform === "win32"
        ? "Windows"
        : platform === "linux"
          ? "Linux"
          : platform;
  return `${hostname()} (${label})`;
}

function scopeOf(readOnly: boolean): string {
  return readOnly ? "openid lazco.read" : "openid lazco.read lazco.write";
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function sameText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Signs in with the Lazco account: the loopback flow (RFC 8252), or the
 * device flow (RFC 8628) when `usesDeviceFlow` says so. Returns the tokens,
 * which the caller checks with `whoami` before it stores them.
 */
export async function signInWithSso(
  options: SsoSignInOptions,
  context: SsoSignInContext,
): Promise<SsoSignIn> {
  const provider = await readProvider(context.client(options.apiUrl));
  const tokens = usesDeviceFlow(options.device, context.io.env, context.platform)
    ? await deviceFlow(provider, options, context)
    : await loopbackFlow(provider, options, context);
  context.addSecret(tokens.accessToken);
  context.addSecret(tokens.refreshToken);
  return { provider, tokens };
}

async function exchange(
  provider: Provider,
  form: Record<string, string>,
  context: SsoSignInContext,
): Promise<TokenAnswer | { error: string; description: string | undefined }> {
  const answer = await postOAuthForm(context.client, provider.tokenEndpoint, {
    client_id: CLI_CLIENT_ID,
    ...form,
  });
  if (!answer.ok) {
    return { error: answer.error, description: answer.description };
  }
  return readTokenAnswer(answer.body);
}

async function loopbackFlow(
  provider: Provider,
  options: SsoSignInOptions,
  context: SsoSignInContext,
): Promise<TokenAnswer> {
  const listener = await startLoopback();
  try {
    const verifier = base64Url(randomBytes(32));
    context.addSecret(verifier);
    const state = base64Url(randomBytes(16));
    const url = new URL(provider.authorizationEndpoint);
    const query: Record<string, string> = {
      response_type: "code",
      client_id: CLI_CLIENT_ID,
      redirect_uri: listener.redirectUri,
      scope: scopeOf(options.readOnly),
      state,
      code_challenge: base64Url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    };
    if (options.organizationHint !== undefined) {
      query.organization_hint = options.organizationHint;
    }
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value);
    }
    writeNotice(context.io, "opening your browser to sign in to Lazco");
    writeNotice(context.io, `if it does not open, visit this URL on this machine: ${url.href}`);
    await context.openBrowser(url.href);

    const callback = await listener.callback(context.loopbackTimeoutMs);
    const returnedState = callback.get("state");
    if (returnedState === null || !sameText(returnedState, state)) {
      throw new CliError(
        "CLI_BAD_RESPONSE",
        "The browser came back with a state this sign-in did not send, so its code was not used",
      );
    }
    if (callback.get("iss") !== provider.issuer) {
      throw new CliError(
        "CLI_BAD_RESPONSE",
        `The browser came back from an issuer other than ${provider.issuer}, so its code was not used`,
        { iss: callback.get("iss") },
      );
    }
    const error = callback.get("error");
    if (error !== null) {
      throw signInRefused(
        error,
        callback.get("error_description") ?? undefined,
        error === "access_denied"
          ? "The sign-in was cancelled in the browser"
          : `The sign-in failed in the browser: ${error}`,
      );
    }
    const code = callback.get("code");
    if (!code) {
      throw new CliError("CLI_BAD_RESPONSE", "The browser came back without a code");
    }
    context.addSecret(code);
    const answer = await exchange(
      provider,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: listener.redirectUri,
        code_verifier: verifier,
        device_name: deviceName(context.platform),
      },
      context,
    );
    if ("error" in answer) {
      throw signInRefused(
        answer.error,
        answer.description,
        `The provider refused the code: ${answer.error}`,
      );
    }
    return answer;
  } finally {
    listener.close();
  }
}

const deviceAnswerSchema = z.looseObject({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().nonnegative().optional(),
});

/** A failure of one poll that the next poll may not meet: no answer, a 429 or a 5xx. */
function isPassing(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof CliError) {
    const status = (error.details as { status?: unknown } | undefined)?.status;
    return (
      error.code === "CLI_NETWORK" ||
      error.code === "CLI_TIMEOUT" ||
      (error.code === "CLI_BAD_RESPONSE" && typeof status === "number" && status >= 500)
    );
  }
  return false;
}

async function deviceFlow(
  provider: Provider,
  options: SsoSignInOptions,
  context: SsoSignInContext,
): Promise<TokenAnswer> {
  const form: Record<string, string> = {
    client_id: CLI_CLIENT_ID,
    scope: scopeOf(options.readOnly),
    device_name: deviceName(context.platform),
  };
  if (options.organizationHint !== undefined) {
    form.organization_hint = options.organizationHint;
  }
  const started = await postOAuthForm(context.client, provider.deviceAuthorizationEndpoint, form);
  if (!started.ok) {
    throw signInRefused(
      started.error,
      started.description,
      `The provider refused the device sign-in: ${started.error}`,
    );
  }
  const parsed = deviceAnswerSchema.safeParse(started.body);
  if (!parsed.success) {
    throw new CliError(
      "CLI_BAD_RESPONSE",
      "The device authorization endpoint answered without a code",
      {
        problem: parsed.error.issues[0]?.path.join(".") ?? "",
      },
    );
  }
  const device = parsed.data;
  context.addSecret(device.device_code);
  writeNotice(
    context.io,
    `to sign in, open ${device.verification_uri} on any device and enter the code ${device.user_code}`,
  );
  writeNotice(
    context.io,
    "enter this code only on that page, and never a code that someone sent you",
  );

  const deadline = context.clock.now() + device.expires_in * 1000;
  // At least a second apart, whatever interval the provider names.
  let intervalMs = Math.max(device.interval ?? DEFAULT_POLL_INTERVAL_SECONDS, 1) * 1000;
  let lastFailure: string | undefined;
  for (;;) {
    await context.clock.sleep(intervalMs);
    if (context.clock.now() > deadline) {
      throw new CliError(
        "CLI_TIMEOUT",
        lastFailure === undefined
          ? `The code was not entered within ${Math.round(device.expires_in / 60)} minutes`
          : `The code expired, and the last poll of the token endpoint failed: ${lastFailure}`,
        { oauthError: "expired_token" },
      );
    }
    let answer: Awaited<ReturnType<typeof exchange>>;
    try {
      answer = await exchange(
        provider,
        { grant_type: DEVICE_CODE_GRANT, device_code: device.device_code },
        context,
      );
    } catch (error) {
      // The person may be halfway through the consent, so a passing failure only skips a poll.
      if (isPassing(error)) {
        lastFailure = toToolError(error).message;
        continue;
      }
      throw error;
    }
    lastFailure = undefined;
    if (!("error" in answer)) {
      return answer;
    }
    switch (answer.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += SLOW_DOWN_STEP_MS;
        continue;
      case "expired_token":
        throw new CliError("CLI_TIMEOUT", "The code expired before the sign-in was allowed", {
          oauthError: answer.error,
        });
      case "access_denied":
        throw signInRefused(answer.error, answer.description, "The sign-in was denied");
      default:
        throw signInRefused(
          answer.error,
          answer.description,
          `The provider refused the device sign-in: ${answer.error}`,
        );
    }
  }
}
