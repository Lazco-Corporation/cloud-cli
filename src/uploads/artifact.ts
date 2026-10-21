import { CliError } from "../core/errors";
import { ARTIFACT_FILES_INPUT, ARTIFACT_PATH_INPUT } from "../core/generate/annotation";
import { ETAG_READ_ENCODING, executeOperation } from "../core/request/execute";
import {
  type ArtifactFile,
  checkGivenFiles,
  encodeArtifactFiles,
  readLocalArtifact,
} from "./artifacts/files";
import type { UploaderContext } from "./registry";

/** The skipped paths a progress line names before it only counts them. */
const SKIPPED_NAMED = 5;

function mebibytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

/**
 * The files of the body, from a local file or directory, or as the input
 * gives them. Either one, never both and never neither.
 */
async function artifactFiles(context: UploaderContext): Promise<ArtifactFile[]> {
  const localPath = context.input[ARTIFACT_PATH_INPUT];
  const given = context.input[ARTIFACT_FILES_INPUT];
  if ((localPath === undefined) === (given === undefined)) {
    const message = `Give either ${ARTIFACT_PATH_INPUT}, a local file or directory, or ${ARTIFACT_FILES_INPUT}, and not both`;
    throw new CliError("CLI_INVALID_INPUT", message, [
      { field: ARTIFACT_PATH_INPUT, message },
      { field: ARTIFACT_FILES_INPUT, message },
    ]);
  }
  if (localPath === undefined) {
    const files = given as ArtifactFile[];
    checkGivenFiles(files);
    return files;
  }
  const local = await readLocalArtifact(String(localPath), {
    workingDirectory: context.workingDirectory,
    homeDirectory: context.homeDirectory,
    requireAbsolute: context.requireAbsolutePaths,
  });
  const totalBytes = local.files.reduce((sum, file) => sum + file.size, 0);
  const named = local.skipped.slice(0, SKIPPED_NAMED).join(", ");
  const more = local.skipped.length > SKIPPED_NAMED ? ", ..." : "";
  context.progress(
    `found ${local.files.length} file${local.files.length === 1 ? "" : "s"} (${mebibytes(totalBytes)}) in ${local.root}${
      local.skipped.length > 0 ? `, skipped ${local.skipped.length}: ${named}${more}` : ""
    }`,
  );
  return encodeArtifactFiles(local.files);
}

/**
 * The artifact uploader, for the publish and the update of an artifact: it
 * reads a local file or directory into `files`, refuses what the API would
 * refuse for its types and limits before anything is sent, and sends the one
 * request. An update with no `ifMatch` reads the current ETag first, as every
 * `concurrency: etag` operation does. The answer is the API's, unchanged.
 */
export async function publishArtifact(context: UploaderContext): Promise<Record<string, unknown>> {
  const { client, operation, signal } = context;
  if (operation.body.mode !== "upload") {
    throw new CliError("CLI_INTERNAL", `${operation.operationId} is not an upload`);
  }
  const files = await artifactFiles(context);
  const body: Record<string, unknown> = {};
  for (const property of operation.body.bodyInputs) {
    if (context.input[property] !== undefined) {
      body[property] = context.input[property];
    }
  }
  body[ARTIFACT_FILES_INPUT] = files;
  const request = { ...context.request, body };

  if (context.dryRun) {
    const preview = {
      ...body,
      files: files.map(({ content, ...file }) => ({ ...file, contentLength: content.length })),
    };
    return {
      dryRun: true,
      method: request.method,
      url: client.url(request),
      headers: client.publicHeaders({ headers: request.headers, body: preview }),
      body: preview,
      ...(operation.annotation.concurrency === "etag" && request.headers?.["If-Match"] === undefined
        ? {
            ifMatchFrom: {
              method: "GET",
              url: client.url({ path: request.path }),
              headers: { "Accept-Encoding": ETAG_READ_ENCODING },
            },
          }
        : {}),
    };
  }
  if (signal.aborted) {
    throw new CliError("CLI_TASK_FAILED", "Interrupted before the publish. Nothing was changed", {
      interrupted: true,
    });
  }

  context.progress(`sending ${files.length} file${files.length === 1 ? "" : "s"}`);
  const answer = await executeOperation(
    operation,
    request,
    { client, clock: context.clock },
    { wait: false, timeoutSeconds: context.timeoutSeconds },
  );
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
    throw new CliError("CLI_BAD_RESPONSE", "The API answered the publish with no object", {
      answer,
    });
  }
  const warnings = (answer as { warnings?: unknown }).warnings;
  if (Array.isArray(warnings) && warnings.length > 0) {
    context.progress(
      `warning: ${warnings.length} thing${warnings.length === 1 ? "" : "s"} in the content will not work, see warnings in the answer`,
    );
  }
  return answer as Record<string, unknown>;
}
