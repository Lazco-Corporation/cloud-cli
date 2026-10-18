import { CliError } from "../core/errors";

export const DEFAULT_API_URL = "https://api.lazco.tw/v1";

const LOCAL_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The API base URL of `--api-url`: `https://` only, except plain HTTP to this
 * machine for local development. A URL with no path means its `/v1`.
 */
export function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("CLI_INVALID_INPUT", "--api-url is not a URL", [
      { field: "api-url", message: "is not a URL" },
    ]);
  }
  const local = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new CliError(
      "CLI_INVALID_INPUT",
      "--api-url must use https://, or http:// to 127.0.0.1, [::1] or localhost",
      [{ field: "api-url", message: "must use https://" }],
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError("CLI_INVALID_INPUT", "--api-url must hold no user, query or fragment", [
      { field: "api-url", message: "must hold no user, query or fragment" },
    ]);
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path || "/v1"}`;
}
