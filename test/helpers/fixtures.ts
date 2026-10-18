import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenApiDocument } from "../../src/core/spec/types";

export const FIXTURE_NAMES = ["surface", "skips"] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export function fixturePath(name: FixtureName): string {
  return join(import.meta.dir, "..", "fixtures", `${name}.json`);
}

/** A fresh copy of a fixture spec, safe to change in a test. */
export function loadFixture(name: FixtureName): OpenApiDocument {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as OpenApiDocument;
}
