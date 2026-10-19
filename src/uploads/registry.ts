import type { Operation } from "../core/generate/operations";
import type { ApiClient, ApiRequest } from "../core/request/client";
import type { Clock } from "../core/request/clock";
import { deployPagesSite } from "./pagesDeployment";

/** What an uploader gets from the CLI command or the MCP tool that runs it. */
export type UploaderContext = {
  operation: Operation;
  /** The checked input object: the path parameters and the uploader's own inputs. */
  input: Record<string, unknown>;
  /** The operation's request for that input, with no body. */
  request: ApiRequest;
  /** The API client with the credential. */
  client: ApiClient;
  /** Check, read and print the request that would start the upload, and change nothing. */
  dryRun: boolean;
  /** How long to wait for the result after the upload. */
  timeoutSeconds: number;
  clock: Clock;
  /** The `fetch` for the storage URLs, which never carries the credential. */
  storageFetch: typeof fetch;
  /** Aborts on Ctrl-C or an MCP cancel. */
  signal: AbortSignal;
  homeDirectory: string;
  workingDirectory: string;
  /** Refuse a relative local path, as the MCP tool must. */
  requireAbsolutePaths: boolean;
  /** One progress line: stderr for the CLI, a progress notification for MCP. */
  progress: (message: string) => void;
};

/** Runs an operation's upload, and answers its one result object. */
export type Uploader = (context: UploaderContext) => Promise<Record<string, unknown>>;

/** The code of each uploader in `KNOWN_UPLOADERS`, by the same name. */
export const UPLOADERS: ReadonlyMap<string, Uploader> = new Map([
  ["pages-deployment", deployPagesSite],
]);
