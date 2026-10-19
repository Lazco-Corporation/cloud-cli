import { CliError } from "../../core/errors";
import type { SiteFile } from "./directory";

export type DeployLimits = {
  fileBytes: number;
  totalBytes: number;
  fileCount: number;
  textBytes: number;
};

/** The answer of `GET /v1/labs/pages/deploy-rules`: the only source of the limits and the extensions. */
export type DeployRules = {
  limits: DeployLimits;
  /** The extensions whose bytes the manifest carries, lowercase, without the dot. */
  contentExtensions: ReadonlySet<string>;
  /** The extensions that upload after every other file. */
  lastExtensions: ReadonlySet<string>;
};

/** The parts of a site the uploader reads. */
export type PagesSite = { id: string; hostname: string; status: string };

const LIMIT_NAMES = ["fileBytes", "totalBytes", "fileCount", "textBytes"] as const;

function badResponse(message: string): CliError {
  return new CliError("CLI_BAD_RESPONSE", message);
}

/** A whole number the API may send as a number or as a numeric string. */
function wholeNumber(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0
    ? number
    : undefined;
}

function extensionList(value: unknown, name: string): ReadonlySet<string> {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw badResponse(`The deploy rules have no list ${name}`);
  }
  return new Set(value.map((item) => item.toLowerCase()));
}

export function parseDeployRules(body: unknown): DeployRules {
  const value = body as {
    limits?: Record<string, unknown>;
    contentExtensions?: unknown;
    lastExtensions?: unknown;
  } | null;
  const limits: Partial<DeployLimits> = {};
  for (const name of LIMIT_NAMES) {
    const limit = wholeNumber(value?.limits?.[name]);
    if (limit === undefined) {
      throw badResponse(`The deploy rules have no limit ${name}`);
    }
    limits[name] = limit;
  }
  return {
    limits: limits as DeployLimits,
    contentExtensions: extensionList(value?.contentExtensions, "contentExtensions"),
    lastExtensions: extensionList(value?.lastExtensions, "lastExtensions"),
  };
}

export function parseSite(body: unknown): PagesSite {
  const value = body as { id?: unknown; hostname?: unknown; status?: unknown } | null;
  if (
    typeof value?.id !== "string" ||
    typeof value.hostname !== "string" ||
    typeof value.status !== "string"
  ) {
    throw badResponse("The site has no id, hostname or status");
  }
  return { id: value.id, hostname: value.hostname, status: value.status };
}

/** A site takes a deploy only while it is `active`. */
export function checkSiteDeployable(site: PagesSite): void {
  if (site.status !== "active") {
    throw new CliError(
      "CLI_INVALID_INPUT",
      `The site ${site.id} is ${site.status}, and only an active site takes a deploy`,
      { siteId: site.id, status: site.status },
    );
  }
}

/** The lowercase text after the last dot of the last segment, as the server reads it. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function isContentFile(path: string, rules: DeployRules): boolean {
  return rules.contentExtensions.has(extensionOf(path));
}

function overLimit(
  limit: keyof DeployLimits,
  max: number,
  actual: number,
  message: string,
  path?: string,
): CliError {
  return new CliError("CLI_INVALID_INPUT", message, {
    limit,
    max,
    actual,
    ...(path === undefined ? {} : { path }),
  });
}

/**
 * Checks the files against the limits from their sizes alone, in the order
 * the server checks them, so no file is read or hashed for a deploy that
 * cannot pass.
 */
export function checkLimits(files: readonly SiteFile[], rules: DeployRules): void {
  const { limits } = rules;
  if (files.length > limits.fileCount) {
    throw overLimit(
      "fileCount",
      limits.fileCount,
      files.length,
      `A deploy holds at most ${limits.fileCount} files, and this one has ${files.length}`,
    );
  }
  let totalBytes = 0;
  let textBytes = 0;
  for (const file of files) {
    if (file.size > limits.fileBytes) {
      throw overLimit(
        "fileBytes",
        limits.fileBytes,
        file.size,
        `${file.path} has ${file.size} bytes, and a file holds at most ${limits.fileBytes}`,
        file.path,
      );
    }
    totalBytes += file.size;
    if (isContentFile(file.path, rules)) {
      textBytes += file.size;
    }
  }
  if (totalBytes > limits.totalBytes) {
    throw overLimit(
      "totalBytes",
      limits.totalBytes,
      totalBytes,
      `A deploy holds at most ${limits.totalBytes} bytes, and this one has ${totalBytes}`,
    );
  }
  if (textBytes > limits.textBytes) {
    throw overLimit(
      "textBytes",
      limits.textBytes,
      textBytes,
      `The content files (${[...rules.contentExtensions].join(", ")}) of a deploy hold at most ${limits.textBytes} bytes, and these hold ${textBytes}`,
    );
  }
}
