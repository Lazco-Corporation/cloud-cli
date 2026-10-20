import { describe, expect, test } from "bun:test";
import { CliError } from "../../src/core/errors";
import { generateSurface, type Operation } from "../../src/core/generate/operations";
import { createAjv } from "../../src/core/request/ajv";
import { pathBelowApiUrl, prepareRequest } from "../../src/core/request/build";
import { guardPathParameters } from "../../src/core/request/guard";
import { InputValidator } from "../../src/core/request/validate";
import { loadFixture } from "../helpers/fixtures";

const ajv = createAjv();
const validator = new InputValidator(ajv);
const operations = generateSurface(loadFixture("surface"), ajv).operations;
const apiUrl = "https://api.lazco.tw/v1";

function operation(command: string): Operation {
  const found = operations.find((candidate) => candidate.command.join(" ") === command);
  if (!found) throw new Error(command);
  return found;
}

function refusal(run: () => unknown): CliError {
  try {
    run();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("input guard", () => {
  const refused: Array<[string, string]> = [
    ["a newline", "srv\n1"],
    ["a tab", "srv\t1"],
    ["a NUL", "srv\u00001"],
    ["DEL", "srv\u007f"],
    ["a traversal", "../admin"],
    ["dots inside", "a..b"],
    ["a single dot, which fetch drops as a path segment", "."],
    ["%2e lower case", "%2e%2e"],
    ["%2E upper case", "%2E%2E"],
    ["%2f lower case", "a%2fb"],
    ["%2F upper case", "a%2Fb"],
    ["%5c lower case", "a%5cb"],
    ["%5C upper case", "a%5Cb"],
    ["a question mark", "srv?admin=1"],
    ["an ampersand", "srv&x"],
    ["an equals sign", "srv=x"],
    ["a double encoding, lower case", "abc%252e"],
    ["a double encoding, upper case", "abc%252E"],
    ["a double-encoded space", "a%2520b"],
    ["an empty value", ""],
  ];
  for (const [label, value] of refused) {
    test(`refuses ${label}`, () => {
      const error = refusal(() => guardPathParameters(["serverId"], { serverId: value }));
      expect(error.code).toBe("CLI_INVALID_INPUT");
      expect(error.details).toEqual([{ field: "serverId", message: expect.any(String) }]);
    });
  }

  test("refuses a value that is not text", () => {
    const error = refusal(() => guardPathParameters(["serverId"], { serverId: { id: 1 } }));
    expect(error.details).toEqual([{ field: "serverId", message: "must be a string" }]);
  });

  test("lists every refused parameter", () => {
    const error = refusal(() =>
      guardPathParameters(["serverId", "snapname"], { serverId: "..", snapname: "a?b" }),
    );
    expect((error.details as Array<{ field: string }>).map((problem) => problem.field)).toEqual([
      "serverId",
      "snapname",
    ]);
  });

  test("passes a plain identifier, once encoded", () => {
    expect(guardPathParameters(["serverId"], { serverId: "srv-1_A.b" })).toEqual({
      serverId: "srv-1_A.b",
    });
  });

  test("encodes a space and a slash with encodeURIComponent", () => {
    const request = prepareRequest(
      operation("compute get"),
      { serverId: "srv 1/2" },
      { apiUrl, validator },
    );
    expect(request.path).toBe("/servers/srv%201%2F2");
  });

  test("refuses before the schema check and sends nothing", () => {
    const error = refusal(() =>
      prepareRequest(operation("compute delete"), { serverId: "../admin" }, { apiUrl, validator }),
    );
    expect(error.details).toEqual([{ field: "serverId", message: "must not hold .." }]);
  });
});

describe("schema check", () => {
  test("a missing required region is listed in details", () => {
    const error = refusal(() =>
      prepareRequest(
        operation("compute create"),
        { hostname: "web-1", planSlug: "s1", quoteId: "q-1", expectedAmount: "402.500" },
        { apiUrl, validator, idempotencyKey: "key-1" },
      ),
    );
    expect(error.code).toBe("CLI_INVALID_INPUT");
    expect(error.details).toEqual([{ field: "regionSlug", message: "is required" }]);
  });

  test("every problem is listed, nested ones by their dotted name", () => {
    const error = refusal(() =>
      prepareRequest(
        operation("compute create"),
        {
          hostname: "",
          regionSlug: "TXG",
          diskGiB: 1.5,
          sshKeys: ["a", 2],
          cloudInit: { userData: 3 },
          colour: "red",
          quoteId: "q-1",
          expectedAmount: "402.500",
        },
        { apiUrl, validator, idempotencyKey: "key-1" },
      ),
    );
    expect(error.details).toEqual(
      expect.arrayContaining([
        { field: "planSlug", message: "is required" },
        { field: "colour", message: "is not an input of this command" },
        { field: "hostname", message: "must NOT have fewer than 1 characters" },
        { field: "regionSlug", message: 'must match pattern "^[a-z0-9-]+$"' },
        { field: "diskGiB", message: "must be integer" },
        { field: "sshKeys[1]", message: "must be string" },
        { field: "cloudInit.userData", message: "must be string" },
      ]),
    );
  });

  test("an enum names its values", () => {
    const error = refusal(() =>
      prepareRequest(
        operation("compute power set"),
        { serverId: "s", action: "explode" },
        { apiUrl, validator },
      ),
    );
    expect(error.details).toEqual([
      {
        field: "action",
        message: 'must be equal to one of the allowed values: "start", "stop", "reboot"',
      },
    ]);
  });
});

describe("request split", () => {
  test("path, query and body go to their places", () => {
    const request = prepareRequest(
      operation("dns records set"),
      { zoneId: "z-1", rrsets: [{ name: "www" }], ifMatch: '"42"' },
      { apiUrl, validator },
    );
    expect(request).toEqual({
      method: "PATCH",
      path: "/dns/zones/z-1/rrsets",
      query: [],
      headers: { "If-Match": '"42"' },
      body: { rrsets: [{ name: "www" }] },
    });
  });

  test("query values are text, and a list repeats", () => {
    const request = prepareRequest(
      operation("compute list"),
      { region: "txg1", limit: 5 },
      { apiUrl, validator },
    );
    expect(request.query).toEqual([
      ["region", "txg1"],
      ["limit", "5"],
    ]);
    expect(request.body).toBeUndefined();
  });

  test("a wrapped body is sent whole", () => {
    const request = prepareRequest(
      operation("projects update"),
      { projectId: "p-1", body: { projectId: "p-1", name: "new" } },
      { apiUrl, validator },
    );
    expect(request.path).toBe("/projects/p-1");
    expect(request.body).toEqual({ projectId: "p-1", name: "new" });
  });

  test("the API URL's own path is not repeated", () => {
    expect(pathBelowApiUrl("https://api.lazco.tw/v1", "/v1/servers")).toBe("/servers");
    expect(pathBelowApiUrl("http://127.0.0.1:3001/v1", "/v1/spec")).toBe("/spec");
    expect(pathBelowApiUrl("https://proxy.example/lazco/v1", "/v1/servers")).toBe("/servers");
    expect(pathBelowApiUrl("http://127.0.0.1:3001", "/v1/servers")).toBe("/v1/servers");
  });
});
