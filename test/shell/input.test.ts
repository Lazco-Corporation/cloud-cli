import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cliEnv, FAKE_TOKEN, makeHome, runLazco } from "../helpers/cli";
import type { FakeApi } from "../helpers/fakeApi";
import { fixtureApi, operationRequests } from "../helpers/fixtureApi";

let api: FakeApi;
let home: Awaited<ReturnType<typeof makeHome>>;

beforeEach(async () => {
  api = fixtureApi();
  home = await makeHome();
});

afterEach(async () => {
  api.stop();
  await home.cleanup();
});

const env = () => cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN });

async function dryBody(args: string[], stdin?: string): Promise<unknown> {
  const run = await runLazco(["--api-url", api.apiUrl, ...args, "--dry-run"], env(), stdin);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);
  return JSON.parse(run.stdout);
}

async function refusal(
  args: string[],
): Promise<{ code: string; details: Array<{ field: string; message: string }> }> {
  const run = await runLazco(["--api-url", api.apiUrl, ...args], env());
  expect(run.code).toBe(1);
  expect(run.stdout).toBe("");
  return JSON.parse(run.stderr.trim().split("\n").pop() as string).error;
}

describe("input from arguments", () => {
  test("a flag and a payload are merged", async () => {
    const preview = await dryBody([
      "compute",
      "create",
      "--json",
      '{"regionSlug":"txg1","planSlug":"s1"}',
      "--hostname",
      "web-1",
    ]);
    expect(preview).toMatchObject({
      method: "POST",
      body: { regionSlug: "txg1", planSlug: "s1", hostname: "web-1" },
    });
  });

  test("kebab-case flags, a repeated flag, a boolean and its negation", async () => {
    const preview = await dryBody([
      "compute",
      "create",
      "--hostname=web-1",
      "--region-slug",
      "txg1",
      "--plan-slug",
      "s1",
      "--ssh-keys",
      "key-a",
      "--ssh-keys",
      "key-b",
      "--no-auto-backup",
    ]);
    expect((preview as { body: unknown }).body).toEqual({
      hostname: "web-1",
      regionSlug: "txg1",
      planSlug: "s1",
      sshKeys: ["key-a", "key-b"],
      autoBackup: false,
    });
  });

  test("a number flag is sent as a number, and a positional fills the path", async () => {
    const list = (await dryBody(["compute", "list", "--limit", "5"])) as { url: string };
    expect(list.url).toBe(`${api.apiUrl}/servers?limit=5`);
    const get = (await dryBody(["compute", "get", "srv 1"])) as { url: string };
    expect(get.url).toBe(`${api.apiUrl}/servers/srv%201`);
  });

  test("--json - reads the payload from stdin", async () => {
    const preview = await dryBody(
      ["compute", "create", "--json", "-"],
      JSON.stringify({
        hostname: "web-1",
        regionSlug: "txg1",
        planSlug: "s1",
        cloudInit: { userData: "#cloud-config" },
      }),
    );
    expect((preview as { body: { cloudInit: unknown } }).body.cloudInit).toEqual({
      userData: "#cloud-config",
    });
  });

  test("a property given by a flag and in --json is refused", async () => {
    const error = await refusal([
      "compute",
      "create",
      "--json",
      '{"hostname":"a","regionSlug":"txg1","planSlug":"s1"}',
      "--hostname",
      "b",
      "--yes",
    ]);
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.details).toEqual([
      { field: "hostname", message: "is given both as an argument and in --json" },
    ]);
    expect(operationRequests(api.requests)).toEqual([]);
  });

  test("a positional given in --json too is refused", async () => {
    const error = await refusal(["compute", "get", "srv-1", "--json", '{"serverId":"srv-2"}']);
    expect(error.details).toEqual([
      { field: "serverId", message: "is given both as an argument and in --json" },
    ]);
  });

  test("a flag given twice is refused", async () => {
    const error = await refusal([
      "compute",
      "create",
      "--hostname",
      "a",
      "--hostname",
      "b",
      "--region-slug",
      "x",
      "--plan-slug",
      "y",
    ]);
    expect(error.details).toEqual([{ field: "hostname", message: "--hostname is given twice" }]);
  });

  test("a payload that is not one object is refused", async () => {
    expect((await refusal(["compute", "create", "--json", "[1]"])).details).toEqual([
      { field: "json", message: "must be an object" },
    ]);
    expect((await refusal(["compute", "create", "--json", "{nope"])).code).toBe(
      "CLI_INVALID_INPUT",
    );
  });

  test("a missing required input names every missing property, without a prompt", async () => {
    const error = await refusal(["compute", "create", "--hostname", "web-1"]);
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.details).toEqual([
      { field: "regionSlug", message: "is required" },
      { field: "planSlug", message: "is required" },
    ]);
  });

  test("a payload key yes skips no confirmation and sends nothing", async () => {
    const error = await refusal([
      "compute",
      "delete",
      "srv-1",
      "--json",
      '{"yes":true,"confirmHostname":"web-1"}',
    ]);
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.details).toEqual([{ field: "yes", message: "is not an input of this command" }]);
    expect(operationRequests(api.requests)).toEqual([]);
  });

  test("a payload key yes on a command with no such input is checked, not obeyed", async () => {
    const error = await refusal([
      "compute",
      "snapshots",
      "delete",
      "srv-1",
      "snap-1",
      "--json",
      '{"yes":true}',
    ]);
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(operationRequests(api.requests)).toEqual([]);
  });

  test("too many positionals are refused", async () => {
    const error = await refusal(["compute", "get", "srv-1", "srv-2"]);
    expect(error.details).toEqual([
      { field: "arguments", message: "expects at most 1 argument (serverId)" },
    ]);
  });
});
