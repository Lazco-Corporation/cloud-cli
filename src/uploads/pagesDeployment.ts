import { CliError, toToolError } from "../core/errors";
import { DIRECTORY_INPUT } from "../core/generate/annotation";
import { pathBelowApiUrl } from "../core/request/build";
import { requireJson } from "../core/request/client";
import { Interrupted } from "./interrupted";
import { resolveSiteDirectory, walkSiteDirectory } from "./pages/directory";
import {
  type Deployment,
  finalizeDeployment,
  parseDeployment,
  waitForDeployment,
} from "./pages/finalize";
import { buildManifest, type ManifestEntry } from "./pages/manifest";
import { checkLimits, checkSiteDeployable, parseDeployRules, parseSite } from "./pages/rules";
import { type SignedUpload, uploadFiles } from "./pages/uploadEngine";
import { UploadWindow } from "./pages/uploadWindow";
import type { UploaderContext } from "./registry";

/** The longest a progress line of one phase waits for the next. */
const PROGRESS_INTERVAL_MS = 1000;
/** The skipped paths a progress line names before it only counts them. */
const SKIPPED_NAMED = 5;

type DeployStart = {
  deployment: Deployment;
  uploads: SignedUpload[];
  index: { rule: string; indexDocument: string | null };
};

function badResponse(message: string): CliError {
  return new CliError("CLI_BAD_RESPONSE", message);
}

function parseUploads(value: unknown): SignedUpload[] {
  if (!Array.isArray(value)) {
    throw badResponse("The answer has no list of uploads");
  }
  return value.map((item) => {
    const upload = item as { path?: unknown; url?: unknown; headers?: unknown } | null;
    const headers = upload?.headers as Record<string, unknown> | null | undefined;
    if (
      typeof upload?.path !== "string" ||
      typeof upload.url !== "string" ||
      headers === null ||
      typeof headers !== "object" ||
      !Object.values(headers).every((header) => typeof header === "string")
    ) {
      throw badResponse("An upload has no path, URL or headers");
    }
    return { path: upload.path, url: upload.url, headers: headers as Record<string, string> };
  });
}

function parseStart(body: unknown): DeployStart {
  const value = body as { deployment?: unknown; uploads?: unknown; index?: unknown } | null;
  const index = value?.index as { rule?: unknown; indexDocument?: unknown } | undefined;
  if (typeof index?.rule !== "string") {
    throw badResponse("The deploy start has no index rule");
  }
  return {
    deployment: parseDeployment(value?.deployment),
    uploads: parseUploads(value?.uploads),
    index: {
      rule: index.rule,
      indexDocument: typeof index.indexDocument === "string" ? index.indexDocument : null,
    },
  };
}

function mebibytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

/** A progress function that drops lines closer than a second apart, except the last of a phase. */
function throttled(context: UploaderContext): (message: string, last: boolean) => void {
  let shownAt = Number.NEGATIVE_INFINITY;
  return (message, last) => {
    const now = context.clock.now();
    if (last || now - shownAt >= PROGRESS_INTERVAL_MS) {
      shownAt = now;
      context.progress(message);
    }
  };
}

/**
 * The Pages deploy uploader: checks a local directory against the deploy
 * rules, sends the manifest, PUTs the changed files, finalizes, and waits
 * until the deployment is live. A failure or an interrupt before finalize
 * cancels the deployment, so the next deploy of the site is not blocked.
 */
export async function deployPagesSite(context: UploaderContext): Promise<Record<string, unknown>> {
  const { client, operation, signal } = context;
  const root = await resolveSiteDirectory(String(context.input[DIRECTORY_INPUT]), {
    workingDirectory: context.workingDirectory,
    homeDirectory: context.homeDirectory,
    requireAbsolute: context.requireAbsolutePaths,
  });
  const siteParameter = operation.pathParameters[0];
  const deploymentsPath = context.request.path;
  const pagesRoot = /^(.*)\/sites\/\{[^}]+\}\/deployments$/.exec(operation.path)?.[1];
  if (siteParameter === undefined || pagesRoot === undefined) {
    throw new CliError(
      "CLI_INTERNAL",
      `The operation at ${operation.path} is not the Pages deploy start this uploader knows`,
    );
  }
  const siteId = String(context.input[siteParameter]);
  const sitePath = deploymentsPath.slice(0, -"/deployments".length);
  const rulesPath = pathBelowApiUrl(client.apiUrl, `${pagesRoot}/deploy-rules`);

  const interruptedBeforeStart = () =>
    new CliError("CLI_TASK_FAILED", "Interrupted before the deploy started. Nothing was changed", {
      interrupted: true,
    });
  let manifest: ManifestEntry[];
  let site: ReturnType<typeof parseSite>;
  let totalBytes = 0;
  let rules: ReturnType<typeof parseDeployRules>;
  let files: Awaited<ReturnType<typeof walkSiteDirectory>>["files"];
  try {
    context.progress(`reading the deploy rules and the site ${siteId}`);
    rules = parseDeployRules(requireJson(await client.call({ method: "GET", path: rulesPath })));
    site = parseSite(requireJson(await client.call({ method: "GET", path: sitePath })));
    checkSiteDeployable(site);
    signal.throwIfAborted();
    const walk = await walkSiteDirectory(root);
    files = walk.files;
    totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const named = walk.skipped.slice(0, SKIPPED_NAMED).join(", ");
    const more = walk.skipped.length > SKIPPED_NAMED ? ", ..." : "";
    context.progress(
      `found ${files.length} files (${mebibytes(totalBytes)}) in ${root}${
        walk.skipped.length > 0 ? `, skipped ${walk.skipped.length}: ${named}${more}` : ""
      }`,
    );
    checkLimits(files, rules);
    const hashProgress = throttled(context);
    manifest = await buildManifest(files, rules, {
      signal,
      onHashed: (count) =>
        hashProgress(`hashed ${count} of ${files.length} files`, count === files.length),
    });
  } catch (error) {
    throw signal.aborted ? interruptedBeforeStart() : error;
  }

  if (context.dryRun) {
    const body = {
      files: manifest.map(({ contentBase64, ...entry }) =>
        contentBase64 === undefined
          ? entry
          : { ...entry, contentBase64Length: contentBase64.length },
      ),
    };
    return {
      dryRun: true,
      method: "POST",
      url: client.url({ path: deploymentsPath }),
      headers: client.publicHeaders({ body }),
      body,
    };
  }
  if (signal.aborted) {
    throw interruptedBeforeStart();
  }

  context.progress(`starting a deployment of ${files.length} files`);
  const startResponse = await client.call({
    method: "POST",
    path: deploymentsPath,
    body: { files: manifest },
  });
  const start = parseStart(requireJson(startResponse));
  const deploymentPath = `${deploymentsPath}/${encodeURIComponent(start.deployment.id)}`;
  let deployment = start.deployment;
  const byPath = new Map(files.map((file) => [file.path, file]));
  let counts: Record<string, number>;

  try {
    if (start.index.rule === "not_found") {
      context.progress(
        "warning: the deploy has no index document, so the site's root answers 404. Set one with the site's documents",
      );
    }
    signal.throwIfAborted();
    const window = new UploadWindow(context.clock);
    window.update(deployment.uploadExpiresAt, startResponse.headers.get("date"));
    const uploadBytes = start.uploads.reduce(
      (sum, upload) => sum + (byPath.get(upload.path)?.size ?? 0),
      0,
    );
    context.progress(
      `uploading ${start.uploads.length} files (${mebibytes(uploadBytes)}), ${files.length - start.uploads.length} unchanged`,
    );
    const uploadProgress = throttled(context);
    const uploaded = await uploadFiles({
      uploads: start.uploads,
      files: new Map(
        manifest.map((entry) => [
          entry.path,
          { file: byPath.get(entry.path) as (typeof files)[number], sha256: entry.sha256 },
        ]),
      ),
      lastExtensions: rules.lastExtensions,
      window,
      renew: async (paths) => {
        context.progress(`renewing the upload URLs of ${paths.length} files`);
        const response = await client.call({
          method: "POST",
          path: `${deploymentPath}/uploads`,
          body: { paths },
        });
        const body = requireJson(response) as { deployment?: unknown; uploads?: unknown } | null;
        const renewed = parseDeployment(body?.deployment);
        window.update(renewed.uploadExpiresAt, response.headers.get("date"));
        return parseUploads(body?.uploads);
      },
      fetch: context.storageFetch,
      clock: context.clock,
      signal,
      onUploaded: (progress) =>
        uploadProgress(
          `uploaded ${progress.files} of ${start.uploads.length} files (${mebibytes(progress.bytes)})`,
          progress.files === start.uploads.length,
        ),
    });
    signal.throwIfAborted();
    context.progress(`finalizing the deployment ${deployment.id}`);
    deployment = await finalizeDeployment(client, deploymentPath);
    counts = {
      files: files.length,
      uploaded: uploaded.uploaded,
      unchanged: files.length - start.uploads.length,
      totalBytes,
      uploadedBytes: uploaded.uploadedBytes,
    };
  } catch (error) {
    const cancelled = await cancelDeployment(context, deploymentPath, deployment.id);
    if (signal.aborted) {
      throw new CliError(
        "CLI_TASK_FAILED",
        `Interrupted during the upload of the deployment ${deployment.id}`,
        { interrupted: true, deployment: cancelled ?? deployment },
      );
    }
    throw error;
  }

  let shownStatus = "";
  const showStatus = (current: Deployment) => {
    if (current.status !== shownStatus) {
      shownStatus = current.status;
      context.progress(`the deployment ${current.id} is ${current.status}`);
    }
  };
  showStatus(deployment);
  try {
    deployment = await waitForDeployment({
      client,
      deploymentPath,
      deployment,
      clock: context.clock,
      timeoutSeconds: context.timeoutSeconds,
      signal,
      onStatus: showStatus,
    });
  } catch (error) {
    if (error instanceof Interrupted || signal.aborted) {
      throw new CliError(
        "CLI_TIMEOUT",
        `Interrupted while waiting. The deployment ${deployment.id} goes on, so read it again later`,
        { interrupted: true, deployment },
      );
    }
    throw error;
  }
  showStatus(deployment);
  return {
    deployment,
    site: { id: site.id, hostname: site.hostname, url: `https://${site.hostname}/` },
    index: start.index,
    ...counts,
  };
}

/** Cancels once, best effort. The error the user sees stays the first one. */
async function cancelDeployment(
  context: UploaderContext,
  deploymentPath: string,
  deploymentId: string,
): Promise<Deployment | undefined> {
  let response: Awaited<ReturnType<typeof context.client.call>>;
  try {
    response = await context.client.call({ method: "POST", path: `${deploymentPath}/cancel` });
  } catch (error) {
    context.progress(
      `warning: the deployment ${deploymentId} could not be cancelled (${toToolError(error).message}). It ends by itself when its upload window does`,
    );
    return undefined;
  }
  context.progress(`cancelled the deployment ${deploymentId}, so the next deploy can start`);
  try {
    return parseDeployment(requireJson(response));
  } catch {
    return undefined;
  }
}
