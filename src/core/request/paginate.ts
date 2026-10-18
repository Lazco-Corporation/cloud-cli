import { CliError } from "../errors";
import type { Operation } from "../generate/operations";
import type { ApiRequest } from "./client";
import { type ExecuteContext, executeOperation } from "./execute";

/** Where the next page is: the input to set, and its value. */
export type NextPage = { input: "cursor"; value: string } | { input: "page"; value: number };

export type Page = { items: unknown[]; next: NextPage | null };

/** The flag that gets the next page, such as `--cursor c-2` or `--page 3`. */
export function nextPageFlag(next: NextPage): string {
  return `--${next.input} ${next.value}`;
}

/**
 * The items and the next page of one answer. Cursor: `{ data, nextCursor }`.
 * Page: `{ data, pagination: { page, totalPages } }`.
 */
export function readPage(operation: Operation, body: unknown): Page {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new CliError("CLI_BAD_RESPONSE", "A paginated answer has no data list", {
      operationId: operation.operationId,
    });
  }
  if (operation.annotation.paginate === "cursor") {
    const nextCursor = (body as { nextCursor?: unknown }).nextCursor;
    return {
      items: data,
      next:
        typeof nextCursor === "string" && nextCursor
          ? { input: "cursor", value: nextCursor }
          : null,
    };
  }
  const pagination = (body as { pagination?: { page?: unknown; totalPages?: unknown } }).pagination;
  const page = Number(pagination?.page);
  const totalPages = Number(pagination?.totalPages);
  return {
    items: data,
    next:
      Number.isInteger(page) && Number.isInteger(totalPages) && page < totalPages
        ? { input: "page", value: page + 1 }
        : null,
  };
}

/**
 * Follows `nextCursor` until it is null, or `page` up to `totalPages`, and
 * returns every item. Each page's input goes through `prepare` again, so the
 * guard and the schema check see it.
 */
export async function walkPages(
  operation: Operation,
  input: Record<string, unknown>,
  prepare: (input: Record<string, unknown>) => ApiRequest,
  context: ExecuteContext,
  onPage?: (pageNumber: number, itemCount: number) => void,
): Promise<unknown[]> {
  const items: unknown[] = [];
  // A cursor or a page number asked for twice means the API ignores it, and the walk would never end.
  const seenPages = new Set<string>();
  let pageInput = input;
  for (let pageNumber = 1; ; pageNumber += 1) {
    const body = await executeOperation(operation, prepare(pageInput), context, {
      wait: false,
      timeoutSeconds: 0,
    });
    const page = readPage(operation, body);
    items.push(...page.items);
    onPage?.(pageNumber, items.length);
    if (!page.next) {
      return items;
    }
    const key = `${page.next.input}:${page.next.value}`;
    if (seenPages.has(key)) {
      throw new CliError(
        "CLI_BAD_RESPONSE",
        `The API sent the same ${page.next.input === "cursor" ? "cursor" : "page"} twice`,
        { [page.next.input]: page.next.value },
      );
    }
    seenPages.add(key);
    pageInput = { ...pageInput, [page.next.input]: page.next.value };
  }
}
