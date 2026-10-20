import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GeneratedSurface,
  generateSurface,
  type Operation,
} from "../../src/core/generate/operations";
import { createAjv } from "../../src/core/request/ajv";
import { HTTP_METHODS, type OpenApiDocument } from "../../src/core/spec/types";
import { normalizeApiUrl } from "../../src/shell/apiUrl";

/** The staging API, or another one for a local backend. */
export const API_URL = normalizeApiUrl(
  process.env.LAZCO_CONTRACT_API_URL ?? "https://api-staging.lazco.tw/v1",
);

/** The built CLI, which `bun run test:contract` builds first. */
export const BUILT_CLI = join(import.meta.dir, "..", "..", "dist", "cli.js");

/** Every SSH key a contract run creates starts with this, so a later run can clean it up. */
export const KEY_NAME_PREFIX = "cli-contract-";

function requiredToken(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set: run bun run test:contract under infisical run --env=staging --path=/ci`,
    );
  }
  return value;
}

export const WRITE_TOKEN = requiredToken("LAZCO_CONTRACT_TOKEN");
export const READ_TOKEN = requiredToken("LAZCO_CONTRACT_READ_TOKEN");

export type Run = { code: number; stdout: string; stderr: string };

/** A temporary HOME, so no run reads or writes the real config, cache or keychain profile. */
export async function temporaryHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), "lazco-contract-"));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

export function cliEnvironment(home: string, token: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_CONFIG_HOME: join(home, "config"),
    LAZCO_TOKEN: token,
    NO_COLOR: "1",
  };
}

/** Runs the built CLI on Node, as an installed package runs. */
export async function lazco(home: string, token: string, args: readonly string[]): Promise<Run> {
  const child = Bun.spawn(["node", BUILT_CLI, "--api-url", API_URL, ...args], {
    env: cliEnvironment(home, token),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/** The error object of a failed run: the last line of stderr. */
export function errorOf(run: Run): { code: string; status?: number; [field: string]: unknown } {
  const line = run.stderr.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line).error;
}

/** The staging spec as the API serves it. */
export async function stagingSpec(): Promise<OpenApiDocument> {
  const response = await fetch(`${API_URL}/spec`);
  if (!response.ok) {
    throw new Error(`GET /v1/spec answered ${response.status}`);
  }
  return (await response.json()) as OpenApiDocument;
}

/** The commands and the skipped operations of a spec, as this version of the generator reads them. */
export function surfaceOf(document: OpenApiDocument): GeneratedSurface {
  return generateSurface(document, createAjv());
}

/** The operations of the staging spec, as this version of the generator reads them. */
export async function stagingOperations(): Promise<readonly Operation[]> {
  return surfaceOf(await stagingSpec()).operations;
}

/** The `operationId` of every operation a spec marks `spend`, read from the spec itself. */
export function specSpendOperationIds(document: OpenApiDocument): string[] {
  return Object.values(document.paths)
    .flatMap((pathItem) => HTTP_METHODS.map((method) => pathItem[method]))
    .filter((operation) => (operation?.["x-lazco"] as { kind?: unknown })?.kind === "spend")
    .map((operation) => operation?.operationId ?? "")
    .sort();
}

/** The organization's features from `whoami`. */
export async function stagingFeatures(token: string): Promise<Record<string, boolean>> {
  const response = await fetch(`${API_URL}/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`GET /v1/whoami answered ${response.status}`);
  }
  return ((await response.json()) as { features: Record<string, boolean> }).features;
}

/** A fresh OpenSSH `ssh-ed25519` public key. */
export function sshPublicKey(comment: string): string {
  const der = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  const raw = der.subarray(der.length - 32);
  const field = (bytes: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const blob = Buffer.concat([field(Buffer.from("ssh-ed25519")), field(raw)]);
  return `ssh-ed25519 ${blob.toString("base64")} ${comment}`;
}
