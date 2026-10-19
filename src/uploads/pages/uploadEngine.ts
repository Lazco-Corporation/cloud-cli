import { ApiError, CliError } from "../../core/errors";
import type { Clock } from "../../core/request/clock";
import { Interrupted } from "../interrupted";
import type { SiteFile } from "./directory";
import { changedDuringDeploy, readSiteFile, sha256Hex } from "./manifest";
import { extensionOf } from "./rules";
import { RENEW_BEFORE_MS, type UploadWindow } from "./uploadWindow";

/** One signed upload of a deploy start or a renewal. */
export type SignedUpload = { path: string; url: string; headers: Record<string, string> };

/** PUTs at once. Each holds one file of at most the file limit in memory. */
export const UPLOAD_CONCURRENCY = 8;
/** Retries of a PUT after a network error, a timeout or a 5xx. */
export const PUT_RETRIES = 3;
const RETRY_DELAYS_MS = [500, 1000, 2000];
/** Retries of a renewal that got no answer or a 5xx: the 10 minutes before the end are for them. */
export const RENEW_RETRIES = 3;
/** The longest the window watch sleeps before it looks at the window again. */
const WATCH_INTERVAL_MS = 60_000;

/** The web app's deadline of one PUT: 30 seconds, plus one second for each 32 KiB. */
export function putDeadlineMs(size: number): number {
  return 30_000 + Math.ceil(size / 32_768) * 1000;
}

/** Waits until the time passes or the signal aborts. */
export type Timer = (milliseconds: number, signal: AbortSignal) => Promise<void>;

const REAL_TIMER: Timer = (milliseconds, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, Math.max(0, milliseconds));
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });

export type UploadEngineOptions = {
  /** The uploads of the deploy start, in its order. */
  uploads: readonly SignedUpload[];
  /** Each file of the manifest and its SHA-256, by path. */
  files: ReadonlyMap<string, { file: SiteFile; sha256: string }>;
  lastExtensions: ReadonlySet<string>;
  window: UploadWindow;
  /** Renews the URLs of these paths, moves the window, and answers the new URLs. */
  renew: (paths: string[]) => Promise<SignedUpload[]>;
  fetch: typeof fetch;
  clock: Clock;
  /** Aborts every PUT and starts no other. */
  signal: AbortSignal;
  concurrency?: number;
  deadlineMs?: (size: number) => number;
  timer?: Timer;
  onUploaded?: (progress: { files: number; bytes: number }) => void;
};

type PutOutcome =
  | { kind: "answer"; status: number; storageCode: string | undefined }
  | { kind: "error"; timedOut: boolean; cause: string };

/** True for a failure that a repeat may not meet: no answer, or a 5xx. */
function isTransient(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status >= 500;
  }
  if (error instanceof CliError) {
    const status = (error.details as { status?: unknown } | null | undefined)?.status;
    return (
      error.code === "CLI_NETWORK" ||
      error.code === "CLI_TIMEOUT" ||
      (error.code === "CLI_BAD_RESPONSE" && typeof status === "number" && status >= 500)
    );
  }
  return false;
}

/** The `<Code>` of a storage error answer, which is S3 XML, not the API's error shape. */
function storageCode(text: string): string | undefined {
  const match = /<Code>([^<]{1,100})<\/Code>/.exec(text);
  return match?.[1];
}

/**
 * PUTs every listed upload with its exact headers: every file whose
 * extension is not in `lastExtensions` first, then the others, at most 8 at a
 * time. It renews the URLs of the uploads not started yet when less than 10
 * minutes of the window remain, and once more for a file refused with 403,
 * and renews with no path when the window runs short after the last PUT.
 */
export async function uploadFiles(
  options: UploadEngineOptions,
): Promise<{ uploaded: number; uploadedBytes: number }> {
  const concurrency = options.concurrency ?? UPLOAD_CONCURRENCY;
  const deadlineMs = options.deadlineMs ?? putDeadlineMs;
  const timer = options.timer ?? REAL_TIMER;
  const current = new Map<string, { upload: SignedUpload; generation: number }>(
    options.uploads.map((upload) => [upload.path, { upload, generation: 0 }]),
  );
  const notStarted = new Set(options.uploads.map((upload) => upload.path));
  /** Started uploads that need a new URL: refused with 403, or about to be sent again late in the window. */
  const needsUrl = new Set<string>();
  const fileOf = (path: string) => {
    const entry = options.files.get(path);
    if (!entry) {
      throw new CliError(
        "CLI_BAD_RESPONSE",
        `The API asked for ${path}, which the deploy does not hold`,
        {
          path,
        },
      );
    }
    return entry;
  };
  for (const upload of options.uploads) {
    fileOf(upload.path);
  }

  const stop = new AbortController();
  let failure: { error: unknown } | undefined;
  const fail = (error: unknown) => {
    failure ??= { error };
    stop.abort();
  };
  const interrupt = () => fail(new Interrupted());
  if (options.signal.aborted) {
    throw new Interrupted();
  }
  options.signal.addEventListener("abort", interrupt, { once: true });
  let renewal: Promise<void> | undefined;
  let uploaded = 0;
  let uploadedBytes = 0;

  /**
   * One renewal at a time, shared by everyone who needs it, of every upload
   * not started and every started one that needs a new URL. A renewal with no answer or a 5xx is
   * sent again while the window is open, because a repeat only moves the
   * window and signs the same paths again.
   */
  const renewShared = (): Promise<void> => {
    renewal ??= (async () => {
      try {
        const paths = [...notStarted, ...[...needsUrl].filter((path) => !notStarted.has(path))];
        let fresh: SignedUpload[];
        for (let attempt = 0; ; attempt += 1) {
          try {
            fresh = await options.renew(paths);
            break;
          } catch (error) {
            if (
              !isTransient(error) ||
              attempt >= RENEW_RETRIES ||
              options.window.remainingMs() <= 0 ||
              stop.signal.aborted
            ) {
              throw error;
            }
            await options.clock.sleep(RETRY_DELAYS_MS[attempt] as number);
          }
        }
        for (const upload of fresh) {
          const entry = current.get(upload.path);
          if (entry) {
            current.set(upload.path, { upload, generation: entry.generation + 1 });
          }
          needsUrl.delete(upload.path);
        }
        if (options.window.needsRenewal()) {
          throw new CliError("CLI_BAD_RESPONSE", "The renewal did not move the upload window", {
            remainingMs: options.window.remainingMs(),
          });
        }
      } finally {
        renewal = undefined;
      }
    })();
    return renewal;
  };

  const ensureWindow = async (): Promise<void> => {
    if (renewal) {
      await renewal;
    }
    if (options.window.needsRenewal()) {
      await renewShared();
    }
  };

  const putOnce = async (upload: SignedUpload, bytes: Uint8Array): Promise<PutOutcome> => {
    // An abort that came before this point fires no listener, so look first.
    if (stop.signal.aborted) {
      throw new Interrupted();
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadlineMs(bytes.length));
    const abort = () => controller.abort();
    stop.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await options.fetch(upload.url, {
        method: "PUT",
        headers: upload.headers,
        body: bytes,
        redirect: "manual",
        signal: controller.signal,
      });
      const text = response.ok ? "" : await response.text();
      return { kind: "answer", status: response.status, storageCode: storageCode(text) };
    } catch (error) {
      if (stop.signal.aborted) {
        throw error;
      }
      return {
        kind: "error",
        timedOut,
        cause: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
      stop.signal.removeEventListener("abort", abort);
    }
  };

  /** Waits until a renewal signs a new URL for a started path, on whichever renewal is in flight. */
  const renewFor = async (path: string, generation: number): Promise<void> => {
    needsUrl.add(path);
    for (let waits = 0; current.get(path)?.generation === generation; waits += 1) {
      if (stop.signal.aborted) {
        throw new Interrupted();
      }
      if (waits >= 3) {
        throw new CliError("CLI_BAD_RESPONSE", `The renewal sent no new URL for ${path}`, {
          path,
        });
      }
      await (renewal ?? renewShared());
    }
  };

  const putFile = async (path: string): Promise<void> => {
    const { file, sha256 } = fileOf(path);
    const bytes = await readSiteFile(file);
    if (sha256Hex(bytes) !== sha256) {
      throw changedDuringDeploy(path);
    }
    let retries = 0;
    let wasRefused = false;
    for (;;) {
      // A PUT never starts with a URL that a renewal in flight is about to replace,
      // nor with one from a window with less than 10 minutes left.
      if (renewal) {
        await renewal;
      }
      const before = current.get(path) as { upload: SignedUpload; generation: number };
      if (options.window.needsRenewal()) {
        await renewFor(path, before.generation);
      }
      const entry = current.get(path) as { upload: SignedUpload; generation: number };
      const outcome = await putOnce(entry.upload, bytes);
      if (outcome.kind === "answer" && outcome.status >= 200 && outcome.status < 300) {
        return;
      }
      if (outcome.kind === "answer" && outcome.status === 403) {
        if (wasRefused) {
          throw new CliError(
            "CLI_BAD_RESPONSE",
            `The storage refused ${path} again after a renewal`,
            {
              path,
              status: outcome.status,
              storageCode: outcome.storageCode,
            },
          );
        }
        // An expired URL, such as after the machine slept: one renewal, one more PUT.
        wasRefused = true;
        await renewFor(path, entry.generation);
        continue;
      }
      const retryable = outcome.kind === "error" || outcome.status >= 500;
      if (retryable && retries < PUT_RETRIES) {
        retries += 1;
        await options.clock.sleep(RETRY_DELAYS_MS[retries - 1] as number);
        if (stop.signal.aborted) {
          throw new Interrupted();
        }
        continue;
      }
      if (outcome.kind === "error") {
        throw new CliError(
          "CLI_NETWORK",
          outcome.timedOut
            ? `The upload of ${path} did not finish within ${Math.round(deadlineMs(bytes.length) / 1000)} seconds, ${PUT_RETRIES + 1} times`
            : `The storage could not be reached for ${path}, ${PUT_RETRIES + 1} times`,
          { path, cause: outcome.cause },
        );
      }
      throw new CliError(
        "CLI_BAD_RESPONSE",
        `The storage refused ${path} with HTTP ${outcome.status}`,
        {
          path,
          status: outcome.status,
          storageCode: outcome.storageCode,
        },
      );
    }
  };

  const runGroup = async (paths: readonly string[]): Promise<void> => {
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stop.signal.aborted) {
          return;
        }
        const path = paths[next];
        next += 1;
        if (path === undefined) {
          return;
        }
        await ensureWindow();
        if (stop.signal.aborted) {
          return;
        }
        notStarted.delete(path);
        await putFile(path);
        uploaded += 1;
        uploadedBytes += fileOf(path).file.size;
        options.onUploaded?.({ files: uploaded, bytes: uploadedBytes });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, paths.length) }, () => worker().catch(fail)),
    );
  };

  /** Renews while PUTs run, even when none starts, so a slow file never outlives the window. */
  const watchWindow = async (): Promise<void> => {
    while (!stop.signal.aborted) {
      if (renewal || options.window.needsRenewal()) {
        try {
          await ensureWindow();
        } catch (error) {
          fail(error);
          return;
        }
        continue;
      }
      const untilRenewal = options.window.remainingMs() - RENEW_BEFORE_MS + 1;
      await timer(Math.max(1, Math.min(untilRenewal, WATCH_INTERVAL_MS)), stop.signal);
    }
  };

  const others = options.uploads
    .filter((upload) => !options.lastExtensions.has(extensionOf(upload.path)))
    .map((upload) => upload.path);
  const last = options.uploads
    .filter((upload) => options.lastExtensions.has(extensionOf(upload.path)))
    .map((upload) => upload.path);

  const watch = watchWindow();
  try {
    await runGroup(others);
    if (!stop.signal.aborted) {
      await runGroup(last);
    }
    if (!stop.signal.aborted) {
      await ensureWindow();
    }
  } catch (error) {
    fail(error);
  } finally {
    stop.abort();
    options.signal.removeEventListener("abort", interrupt);
    await watch;
  }
  if (failure) {
    throw failure.error;
  }
  return { uploaded, uploadedBytes };
}
