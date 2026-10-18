import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import packageJson from "../../package.json" with { type: "json" };
import { cliEnv, FAKE_TOKEN, makeHome, runLazco, seedSpecCache } from "../helpers/cli";
import type { FakeApi } from "../helpers/fakeApi";
import { fixtureApi } from "../helpers/fixtureApi";
import { loadFixture } from "../helpers/fixtures";

let api: FakeApi;
let home: Awaited<ReturnType<typeof makeHome>>;

beforeEach(async () => {
  api = fixtureApi();
  home = await makeHome();
  await seedSpecCache(home.cache, api.apiUrl, loadFixture("surface"));
});

afterEach(async () => {
  api.stop();
  await home.cleanup();
});

const env = () => cliEnv(home.home, { LAZCO_TOKEN: FAKE_TOKEN });

describe("--dry-run", () => {
  test("a dry delete prints the request, asks nothing and sends nothing", async () => {
    const run = await runLazco(
      [
        "--api-url",
        api.apiUrl,
        "compute",
        "delete",
        "srv-1",
        "--confirm-hostname",
        "web-1",
        "--dry-run",
      ],
      env(),
    );
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual({
      dryRun: true,
      method: "DELETE",
      url: `${api.apiUrl}/servers/srv-1`,
      headers: {
        Accept: "application/json",
        "User-Agent": `lazco-cli/${packageJson.version}`,
        "Content-Type": "application/json",
      },
      body: { confirmHostname: "web-1" },
    });
    expect(api.requests).toEqual([]);
  });

  test("the printed request holds no credential", async () => {
    const run = await runLazco(["--api-url", api.apiUrl, "compute", "list", "--dry-run"], env());
    const preview = JSON.parse(run.stdout);
    expect(Object.keys(preview.headers).map((name) => name.toLowerCase())).not.toContain(
      "authorization",
    );
    expect(run.stdout).not.toContain(FAKE_TOKEN.slice(-16));
    expect(api.requests).toEqual([]);
  });

  test("an etag command without ifMatch names the read it would make, and makes none", async () => {
    const run = await runLazco(
      [
        "--api-url",
        api.apiUrl,
        "dns",
        "records",
        "set",
        "z-1",
        "--json",
        '{"rrsets":[]}',
        "--dry-run",
      ],
      env(),
    );
    expect(JSON.parse(run.stdout)).toMatchObject({
      method: "PATCH",
      ifMatchFrom: {
        method: "GET",
        url: `${api.apiUrl}/dns/zones/z-1/rrsets`,
        headers: { "Accept-Encoding": "identity" },
      },
    });
    expect(api.requests).toEqual([]);
  });

  test("the input is still checked", async () => {
    const run = await runLazco(
      ["--api-url", api.apiUrl, "compute", "create", "--hostname", "web-1", "--dry-run"],
      env(),
    );
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(JSON.parse(run.stderr).error.code).toBe("CLI_INVALID_INPUT");
    expect(api.requests).toEqual([]);
  });

  test("it needs no credential", async () => {
    const run = await runLazco(
      ["--api-url", api.apiUrl, "compute", "list", "--dry-run"],
      cliEnv(home.home),
    );
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).dryRun).toBe(true);
  });
});
