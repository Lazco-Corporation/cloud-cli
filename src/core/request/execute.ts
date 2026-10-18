import { CliError } from "../errors";
import type { Operation } from "../generate/operations";
import { type ApiClient, type ApiRequest, requireJson } from "./client";
import { type Clock, SYSTEM_CLOCK } from "./clock";
import { pathValueProblem } from "./guard";

export const DEFAULT_WAIT_SECONDS = 600;
const FIRST_TASK_READ_MS = 2000;
const TASK_READ_GROWTH = 1.5;
const MAX_TASK_READ_MS = 10_000;

export type Task = { id?: string; status?: string; error?: unknown; [field: string]: unknown };

export type ExecuteOptions = {
  /** Wait for an `async: task` operation until its task ends. */
  wait: boolean;
  timeoutSeconds: number;
  onTask?: (task: Task) => void;
};

export type ExecuteContext = { client: ApiClient; clock?: Clock };

/**
 * Sends one prepared request of an operation and returns the JSON answer:
 * with the ETag read first for `concurrency: etag` when no `If-Match` is
 * given, and with the task waited for when the operation is `async: task`.
 */
export async function executeOperation(
  operation: Operation,
  request: ApiRequest,
  context: ExecuteContext,
  options: ExecuteOptions,
): Promise<unknown> {
  const headers = { ...request.headers };
  if (operation.annotation.concurrency === "etag" && headers["If-Match"] === undefined) {
    headers["If-Match"] = await readCurrentEtag(context.client, request.path);
  }
  const response = await context.client.call({ ...request, headers });
  const body = requireJson(response);
  if (operation.annotation.async !== "task" || response.status !== 202 || !options.wait) {
    return body;
  }
  const taskId = (body as { taskId?: unknown } | null)?.taskId;
  if (typeof taskId !== "string") {
    return body;
  }
  return waitForTask(context, body, taskId, options);
}

/**
 * The ETag of the resource now. It guards only the moment between this read
 * and the write, which is why an `ifMatch` the caller read earlier is better.
 */
async function readCurrentEtag(client: ApiClient, path: string): Promise<string> {
  const response = await client.call({ method: "GET", path });
  const etag = response.headers.get("etag");
  if (!etag) {
    throw new CliError("CLI_BAD_RESPONSE", "The API sent no ETag for the resource", {
      method: "GET",
      url: client.url({ path }),
    });
  }
  return etag;
}

/**
 * Reads the task 2 seconds after the 202, then 1.5 times later each time, up
 * to 10 seconds apart. The answer keeps the 202 body, because a value such as
 * a rebuild's password is sent there only.
 */
export async function waitForTask(
  context: ExecuteContext,
  accepted: unknown,
  taskId: string,
  options: Pick<ExecuteOptions, "timeoutSeconds" | "onTask">,
): Promise<{ accepted: unknown; task: Task }> {
  const problem = pathValueProblem(taskId);
  if (problem) {
    throw new CliError("CLI_BAD_RESPONSE", `The API sent a task id that ${problem}`, { taskId });
  }
  const clock = context.clock ?? SYSTEM_CLOCK;
  const deadline = clock.now() + options.timeoutSeconds * 1000;
  let delay = FIRST_TASK_READ_MS;
  for (;;) {
    const remaining = deadline - clock.now();
    if (remaining <= 0) {
      throw new CliError(
        "CLI_TIMEOUT",
        `The task did not end within ${options.timeoutSeconds} seconds`,
        {
          taskId,
        },
      );
    }
    await clock.sleep(Math.min(delay, remaining));
    delay = Math.min(delay * TASK_READ_GROWTH, MAX_TASK_READ_MS);
    const response = await context.client.call({
      method: "GET",
      path: `/tasks/${encodeURIComponent(taskId)}`,
    });
    const task = requireJson(response) as Task;
    options.onTask?.(task);
    if (task?.status === "completed") {
      return { accepted, task };
    }
    if (task?.status === "failed") {
      const reason = typeof task.error === "string" && task.error ? task.error : "The task failed";
      throw new CliError("CLI_TASK_FAILED", reason, { accepted, task });
    }
  }
}
