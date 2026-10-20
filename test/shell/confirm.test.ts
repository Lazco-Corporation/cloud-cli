import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cliEnv, FAKE_TOKEN, makeHome, runLazco, runLazcoOnTerminal } from "../helpers/cli";
import type { FakeApi } from "../helpers/fakeApi";
import { json } from "../helpers/fakeApi";
import { fixtureApi, operationRequests } from "../helpers/fixtureApi";

let api: FakeApi;
let home: Awaited<ReturnType<typeof makeHome>>;

beforeEach(async () => {
  api = fixtureApi();
  home = await makeHome();
  const handler = api.handler;
  api.handler = (request) =>
    request.method === "DELETE" && request.path.includes("/snapshots/")
      ? json(200, { deleted: true })
      : handler(request);
});

afterEach(async () => {
  api.stop();
  await home.cleanup();
});

const env = () => cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN, NO_COLOR: "1" });

function lastError(stderr: string): { code: string; details?: unknown } {
  return JSON.parse(stderr.trim().split("\n").pop() as string).error;
}

function deletes() {
  return api.requests.filter((request) => request.method === "DELETE");
}

describe("confirmation", () => {
  test("no terminal and no --yes is CLI_CONFIRM_REQUIRED and sends nothing", async () => {
    const run = await runLazco(
      ["--api-url", api.apiUrl, "compute", "delete", "srv-1", "--confirm-hostname", "web-1"],
      env(),
    );
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(lastError(run.stderr).code).toBe("CLI_CONFIRM_REQUIRED");
    expect(deletes()).toEqual([]);
  });

  test("--yes without the confirm field is CLI_CONFIRM_REQUIRED and sends nothing", async () => {
    const run = await runLazco(
      ["--api-url", api.apiUrl, "compute", "delete", "srv-1", "--yes"],
      env(),
    );
    expect(run.code).toBe(1);
    expect(lastError(run.stderr)).toMatchObject({
      code: "CLI_CONFIRM_REQUIRED",
      details: { field: "confirmHostname" },
    });
    expect(lastError(run.stderr)).toMatchObject({
      message: expect.stringContaining("--confirm-hostname"),
    });
    expect(deletes()).toEqual([]);
  });

  test("--yes with the confirm field sends it and waits for the task", async () => {
    const run = await runLazco(
      [
        "--api-url",
        api.apiUrl,
        "compute",
        "delete",
        "srv-1",
        "--yes",
        "--confirm-hostname",
        "web-1",
      ],
      env(),
    );
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      accepted: { taskId: "t-1" },
      task: { id: "t-1", status: "completed", progress: 100 },
    });
    expect(deletes()[0]?.body).toEqual({ confirmHostname: "web-1" });
    expect(run.stderr).toContain("task t-1 completed 100%");
  });

  test("--no-wait prints the 202 body at once", async () => {
    const run = await runLazco(
      [
        "--api-url",
        api.apiUrl,
        "compute",
        "create",
        "--yes",
        "--no-wait",
        "--hostname",
        "w",
        "--region-slug",
        "txg1",
        "--plan-slug",
        "s1",
      ],
      env(),
    );
    expect(JSON.parse(run.stdout)).toEqual({ taskId: "t-1", password: "once-only" });
    expect(operationRequests(api.requests)).toEqual(["POST /v1/servers/quote", "POST /v1/servers"]);
  });

  test("on a pseudo-terminal the typed name lands in the confirm field", async () => {
    const run = await runLazcoOnTerminal(
      ["--api-url", api.apiUrl, "compute", "delete", "srv-1"],
      env(),
      [{ after: "Type the resource name to confirm (confirmHostname)", type: "web-1" }],
    );
    expect(run.code).toBe(0);
    expect(deletes()[0]?.body).toEqual({ confirmHostname: "web-1" });
    expect(run.output).toContain('"accepted":{"taskId":"t-1"}');
  });

  test("on a pseudo-terminal an empty name cancels", async () => {
    const run = await runLazcoOnTerminal(
      ["--api-url", api.apiUrl, "compute", "delete", "srv-1"],
      env(),
      [{ after: "Type the resource name", type: "" }],
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("CLI_CONFIRM_REQUIRED");
    expect(deletes()).toEqual([]);
  });

  test("on a pseudo-terminal a command without a confirm field asks [y/N]", async () => {
    const refused = await runLazcoOnTerminal(
      ["--api-url", api.apiUrl, "compute", "snapshots", "delete", "srv-1", "snap-1"],
      env(),
      [{ after: "[y/N]", type: "n" }],
    );
    expect(refused.code).toBe(1);
    expect(deletes()).toEqual([]);
    const accepted = await runLazcoOnTerminal(
      ["--api-url", api.apiUrl, "compute", "snapshots", "delete", "srv-1", "snap-1"],
      env(),
      [{ after: "[y/N]", type: "y" }],
    );
    expect(accepted.code).toBe(0);
    expect(deletes().map((request) => request.path)).toEqual([
      "/v1/servers/srv-1/snapshots/snap-1",
    ]);
  });

  test("a doomed command fails before it asks", async () => {
    const run = await runLazcoOnTerminal(
      ["--api-url", api.apiUrl, "compute", "create", "--hostname", "w"],
      env(),
    );
    expect(run.code).toBe(1);
    expect(run.output).not.toContain("[y/N]");
    expect(run.output).toContain("CLI_INVALID_INPUT");
  });

  test("a write runs without a terminal and without --yes", async () => {
    const handler = api.handler;
    api.handler = (request) =>
      request.path.endsWith("/actions") ? json(200, { action: "reboot" }) : handler(request);
    const run = await runLazco(
      ["--api-url", api.apiUrl, "compute", "power", "set", "srv-1", "--action", "reboot"],
      env(),
    );
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ action: "reboot" });
  });
});
