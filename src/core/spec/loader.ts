import { join } from "node:path";
import { readJsonFile, writeFileAtomic } from "../../config/atomicFile";
import { sha256Hex } from "../../config/paths";
import { CliError, toToolError } from "../errors";
import { type ApiClient, NotJson } from "../request/client";
import { type Clock, SYSTEM_CLOCK } from "../request/clock";
import { isOpenApiDocument, type OpenApiDocument } from "./types";

/** A cached spec younger than this is used without a request. */
export const SPEC_FRESH_MS = 10 * 60 * 1000;

type CacheEntry = {
  apiUrl: string;
  etag: string | null;
  checkedAt: number;
  spec: OpenApiDocument;
};

export type LoadedSpec = {
  document: OpenApiDocument;
  etag: string | null;
  /** `cache`: fresh copy, no request. `network`: checked this run. `stale`: the check failed. */
  origin: "cache" | "network" | "stale";
};

export type SpecSourceOptions = {
  /** A client for the API URL. The spec request never carries its credential. */
  client: ApiClient;
  /** The `lazco` cache root. The spec lives in `spec/` below it. */
  cacheDirectory: string;
  warn: (message: string) => void;
  clock?: Clock;
};

/** The spec of one API URL for one process, read from the disk cache or the API. */
export class SpecSource {
  private readonly options: SpecSourceOptions;
  private readonly clock: Clock;
  private current: LoadedSpec | undefined;
  private checkedThisRun = false;
  private warned = false;

  constructor(options: SpecSourceOptions) {
    this.options = options;
    this.clock = options.clock ?? SYSTEM_CLOCK;
  }

  get cachePath(): string {
    return join(
      this.options.cacheDirectory,
      "spec",
      `${sha256Hex(this.options.client.apiUrl)}.json`,
    );
  }

  async get(): Promise<LoadedSpec> {
    if (this.current) {
      return this.current;
    }
    const entry = await this.readEntry();
    if (entry && this.clock.now() - entry.checkedAt < SPEC_FRESH_MS) {
      this.current = { document: entry.spec, etag: entry.etag, origin: "cache" };
      return this.current;
    }
    this.current = await this.check(entry);
    return this.current;
  }

  /**
   * Gets the spec again, ignoring its age, for a command name the cached copy
   * lacks. Returns `undefined` when this run already asked the API, because a
   * second request would answer the same.
   */
  async refresh(): Promise<LoadedSpec | undefined> {
    if (this.checkedThisRun) {
      return undefined;
    }
    this.current = await this.check(await this.readEntry());
    return this.current;
  }

  /**
   * Checks the spec by ETag whatever its age and however often this run
   * asked, for a long-running process such as the MCP server.
   */
  async revalidate(): Promise<LoadedSpec> {
    this.current = await this.check(await this.readEntry());
    return this.current;
  }

  private async check(entry: CacheEntry | undefined): Promise<LoadedSpec> {
    this.checkedThisRun = true;
    const client = this.options.client;
    let failure: unknown;
    try {
      const response = await client.send({
        method: "GET",
        path: "/spec",
        headers: entry?.etag ? { "If-None-Match": entry.etag } : {},
        authenticate: false,
      });
      if (response.status === 304 && entry) {
        await this.writeEntry({ ...entry, checkedAt: this.clock.now() });
        return { document: entry.spec, etag: entry.etag, origin: "network" };
      }
      if (response.status === 200 && isOpenApiDocument(response.body)) {
        const etag = response.headers.get("etag");
        await this.writeEntry({
          apiUrl: client.apiUrl,
          etag,
          checkedAt: this.clock.now(),
          spec: response.body,
        });
        return { document: response.body, etag, origin: "network" };
      }
      failure = {
        status: response.status,
        contentType:
          response.body instanceof NotJson
            ? response.body.contentType
            : response.headers.get("content-type"),
      };
    } catch (error) {
      failure = toToolError(error).toBody();
    }
    if (entry) {
      this.warnOnce(
        `the API spec could not be checked, so the copy cached at ${new Date(entry.checkedAt).toISOString()} is used`,
      );
      return { document: entry.spec, etag: entry.etag, origin: "stale" };
    }
    throw new CliError("CLI_SPEC_UNAVAILABLE", "The API spec could not be loaded", {
      url: client.url({ path: "/spec" }),
      cause: failure,
    });
  }

  private warnOnce(message: string): void {
    if (!this.warned) {
      this.warned = true;
      this.options.warn(message);
    }
  }

  private async readEntry(): Promise<CacheEntry | undefined> {
    const value = (await readJsonFile(this.cachePath)) as Partial<CacheEntry> | undefined;
    if (
      !value ||
      value.apiUrl !== this.options.client.apiUrl ||
      typeof value.checkedAt !== "number" ||
      !(typeof value.etag === "string" || value.etag === null) ||
      !isOpenApiDocument(value.spec)
    ) {
      return undefined;
    }
    return value as CacheEntry;
  }

  private async writeEntry(entry: CacheEntry): Promise<void> {
    try {
      await writeFileAtomic(this.cachePath, JSON.stringify(entry));
    } catch (error) {
      this.warnOnce(`the API spec could not be cached: ${toToolError(error).message}`);
    }
  }
}
