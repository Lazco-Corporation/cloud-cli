import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CliError } from "../../src/core/errors";
import { generateSurface, type Operation } from "../../src/core/generate/operations";
import { createAjv } from "../../src/core/request/ajv";
import { prepareRequest } from "../../src/core/request/build";
import { ApiClient } from "../../src/core/request/client";
import { executeOperation } from "../../src/core/request/execute";
import { nextPageFlag, readPage, walkPages } from "../../src/core/request/paginate";
import { RateLimiter } from "../../src/core/request/rateLimiter";
import { InputValidator } from "../../src/core/request/validate";
import { FakeApi, fakeClock, json } from "../helpers/fakeApi";
import { loadFixture } from "../helpers/fixtures";

const ajv = createAjv();
const validator = new InputValidator(ajv);
const operations = generateSurface(loadFixture("surface"), ajv).operations;

function operation(command: string): Operation {
  const found = operations.find((candidate) => candidate.command.join(" ") === command);
  if (!found) throw new Error(command);
  return found;
}

let api: FakeApi;
beforeEach(() => {
  api = new FakeApi();
});
afterEach(() => {
  api.stop();
});

function context() {
  const clock = fakeClock();
  return {
    clock,
    client: new ApiClient({
      apiUrl: api.apiUrl,
      userAgent: "lazco-cli/test",
      limiter: new RateLimiter(clock),
      clock,
    }),
  };
}

/** Cursor pages c-1 (first), c-2, c-3; the last has a null nextCursor. */
function cursorServer() {
  api.handler = (request) => {
    const cursor = new URLSearchParams(request.search).get("cursor") ?? "c-1";
    const index = Number(cursor.slice(2));
    return json(200, {
      data: [{ id: `s-${index}a` }, { id: `s-${index}b` }],
      nextCursor: index < 3 ? `c-${index + 1}` : null,
    });
  };
}

function pageServer(totalPages: number) {
  api.handler = (request) => {
    const page = Number(new URLSearchParams(request.search).get("page") ?? "1");
    return json(200, {
      data: [{ id: `n-${page}` }],
      pagination: { page, limit: 1, total: totalPages, totalPages },
    });
  };
}

describe("pagination", () => {
  test("one cursor page names the next --cursor", async () => {
    cursorServer();
    const list = operation("compute list");
    const body = await executeOperation(
      list,
      prepareRequest(list, {}, { apiUrl: api.apiUrl, validator }),
      context(),
      {
        wait: false,
        timeoutSeconds: 0,
      },
    );
    const page = readPage(list, body);
    expect(page.items).toEqual([{ id: "s-1a" }, { id: "s-1b" }]);
    expect(page.next && nextPageFlag(page.next)).toBe("--cursor c-2");
    expect(api.requests).toHaveLength(1);
  });

  test("one page names the next --page", () => {
    const page = readPage(operation("notifications list"), {
      data: [{ id: "n-1" }],
      pagination: { page: 1, limit: 1, total: 2, totalPages: 2 },
    });
    expect(page.next && nextPageFlag(page.next)).toBe("--page 2");
    expect(
      readPage(operation("notifications list"), {
        data: [],
        pagination: { page: 2, totalPages: 2 },
      }).next,
    ).toBeNull();
  });

  test("--page-all stops at a null nextCursor", async () => {
    cursorServer();
    const list = operation("compute list");
    const pages: number[] = [];
    const items = await walkPages(
      list,
      { limit: 2 },
      (input) => prepareRequest(list, input, { apiUrl: api.apiUrl, validator }),
      context(),
      (pageNumber) => pages.push(pageNumber),
    );
    expect(items.map((item) => (item as { id: string }).id)).toEqual([
      "s-1a",
      "s-1b",
      "s-2a",
      "s-2b",
      "s-3a",
      "s-3b",
    ]);
    expect(pages).toEqual([1, 2, 3]);
    expect(api.requests.map((request) => request.search)).toEqual([
      "?limit=2",
      "?limit=2&cursor=c-2",
      "?limit=2&cursor=c-3",
    ]);
  });

  test("--page-all stops at totalPages", async () => {
    pageServer(3);
    const list = operation("notifications list");
    const items = await walkPages(
      list,
      {},
      (input) => prepareRequest(list, input, { apiUrl: api.apiUrl, validator }),
      context(),
    );
    expect(items).toEqual([{ id: "n-1" }, { id: "n-2" }, { id: "n-3" }]);
    expect(api.requests.map((request) => request.search)).toEqual(["", "?page=2", "?page=3"]);
  });

  test("a cursor sent twice stops the walk", async () => {
    api.handler = () => json(200, { data: [], nextCursor: "same" });
    const list = operation("compute list");
    const error = (await walkPages(
      list,
      {},
      (input) => prepareRequest(list, input, { apiUrl: api.apiUrl, validator }),
      context(),
    ).catch((failure: unknown) => failure)) as CliError;
    expect(error.code).toBe("CLI_BAD_RESPONSE");
    expect(api.requests).toHaveLength(2);
  });

  test("an API that ignores the page number stops the walk", async () => {
    api.handler = () =>
      json(200, { data: [{ id: "n-1" }], pagination: { page: 1, totalPages: 5 } });
    const list = operation("notifications list");
    const error = (await walkPages(
      list,
      {},
      (input) => prepareRequest(list, input, { apiUrl: api.apiUrl, validator }),
      context(),
    ).catch((failure: unknown) => failure)) as CliError;
    expect(error.code).toBe("CLI_BAD_RESPONSE");
    expect(error.details).toEqual({ page: 2 });
    expect(api.requests).toHaveLength(2);
  });

  test("an answer with no data list is CLI_BAD_RESPONSE", () => {
    expect(() => readPage(operation("compute list"), { servers: [] })).toThrow(CliError);
  });
});
