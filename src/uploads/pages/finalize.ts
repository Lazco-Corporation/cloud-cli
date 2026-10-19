import { ApiError, CliError } from "../../core/errors";
import { type ApiClient, requireJson } from "../../core/request/client";
import type { Clock } from "../../core/request/clock";
import { Interrupted } from "../interrupted";

/** How often the wait reads the deployment. The finalize job runs every 15 seconds. */
export const POLL_INTERVAL_MS = 5000;

export type Deployment = {
  id: string;
  status: string;
  error?: unknown;
  uploadExpiresAt?: unknown;
  [field: string]: unknown;
};

const SUCCEEDED: ReadonlySet<string> = new Set(["live", "superseded"]);
const ENDED_WITHOUT_GOING_LIVE: ReadonlySet<string> = new Set(["failed", "abandoned", "cancelled"]);

export function parseDeployment(body: unknown): Deployment {
  const value = body as { id?: unknown; status?: unknown } | null;
  if (typeof value?.id !== "string" || typeof value.status !== "string") {
    throw new CliError("CLI_BAD_RESPONSE", "The deployment has no id or status");
  }
  return value as Deployment;
}

/** True for an error that means the request got no answer, so its outcome is unknown. */
function gotNoAnswer(error: unknown): boolean {
  return (
    error instanceof CliError && (error.code === "CLI_NETWORK" || error.code === "CLI_TIMEOUT")
  );
}

async function readDeployment(client: ApiClient, deploymentPath: string): Promise<Deployment> {
  return parseDeployment(requireJson(await client.call({ method: "GET", path: deploymentPath })));
}

/**
 * Calls finalize. Finalize has no `Idempotency-Key`, so after a request with
 * no answer it reads the deployment and calls finalize again only while the
 * deployment is still `uploading`.
 */
export async function finalizeDeployment(
  client: ApiClient,
  deploymentPath: string,
): Promise<Deployment> {
  const finalize = async () =>
    parseDeployment(
      requireJson(await client.call({ method: "POST", path: `${deploymentPath}/finalize` })),
    );
  try {
    return await finalize();
  } catch (error) {
    if (!gotNoAnswer(error)) {
      throw error;
    }
  }
  const deployment = await readDeployment(client, deploymentPath);
  return deployment.status === "uploading" ? finalize() : deployment;
}

/** Sleeps on the clock, and wakes early when the signal aborts. */
async function pause(clock: Clock, milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  let onAbort = () => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
  });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([clock.sleep(milliseconds), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Reads the deployment every 5 seconds until it is `live` or `superseded`,
 * which it returns, or `failed`, `abandoned` or `cancelled`, which are
 * `CLI_TASK_FAILED`. It ends with `CLI_TIMEOUT` after `timeoutSeconds`, and
 * the deployment goes on.
 */
export async function waitForDeployment(options: {
  client: ApiClient;
  deploymentPath: string;
  deployment: Deployment;
  clock: Clock;
  timeoutSeconds: number;
  signal: AbortSignal;
  onStatus?: (deployment: Deployment) => void;
}): Promise<Deployment> {
  const deadline = options.clock.now() + options.timeoutSeconds * 1000;
  let deployment = options.deployment;
  for (;;) {
    if (SUCCEEDED.has(deployment.status)) {
      return deployment;
    }
    if (ENDED_WITHOUT_GOING_LIVE.has(deployment.status)) {
      const error = typeof deployment.error === "string" ? deployment.error : null;
      throw new CliError(
        "CLI_TASK_FAILED",
        `The deployment ${deployment.id} ended ${deployment.status}${error ? `: ${error}` : ""}`,
        { deployment, error },
      );
    }
    const remaining = deadline - options.clock.now();
    if (remaining <= 0) {
      throw new CliError(
        "CLI_TIMEOUT",
        `The deployment ${deployment.id} was not live within ${options.timeoutSeconds} seconds. It goes on, so read it again later`,
        { deployment },
      );
    }
    await pause(options.clock, Math.min(POLL_INTERVAL_MS, remaining), options.signal);
    if (options.signal.aborted) {
      throw new Interrupted();
    }
    try {
      deployment = await readDeployment(options.client, options.deploymentPath);
    } catch (error) {
      // The client already tried the read again. The deployment goes on, so the wait does too.
      if (!gotNoAnswer(error) && !(error instanceof ApiError && error.status >= 500)) {
        throw error;
      }
      continue;
    }
    options.onStatus?.(deployment);
  }
}
