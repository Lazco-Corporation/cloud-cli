/**
 * Prints THIRD_PARTY_NOTICES.txt for a compiled binary: the license of every
 * package in the production dependency tree, plus the one native keychain
 * package of the target, and the Bun runtime the binary embeds.
 *
 * Usage: bun scripts/third-party-notices.ts <native keychain package>
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type PackageJson = {
  name: string;
  version: string;
  license?: string | { type?: string };
  dependencies?: Record<string, string>;
  repository?: string | { url?: string };
};

const root = join(import.meta.dir, "..");
const nativePackage = process.argv[2];
if (!nativePackage) {
  console.error("usage: bun scripts/third-party-notices.ts <native keychain package>");
  process.exit(1);
}

function readPackage(directory: string): PackageJson {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as PackageJson;
}

/** Where Node would find `name` from `fromDirectory`: its own node_modules, then each parent's. */
function resolvePackage(name: string, fromDirectory: string): string {
  for (let directory = fromDirectory; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
    if (directory === root || dirname(directory) === directory) {
      throw new Error(`${name} is not installed below ${fromDirectory}`);
    }
  }
}

/**
 * The package's license file. A native package of napi-rs ships none, so its
 * declared license and repository stand in, and the main package's entry
 * carries the full text.
 */
function licenseText(directory: string, manifest: PackageJson, license: string): string {
  const file = readdirSync(directory).find((entry) => /^(licen[cs]e|copying)(\.|$)/i.test(entry));
  if (file) {
    return readFileSync(join(directory, file), "utf8").trim();
  }
  if (!license) {
    throw new Error(`${manifest.name} has no license file and declares no license`);
  }
  const repository =
    typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  return `This package ships no license file. Its package.json declares ${license}${repository ? `, and its source is ${repository}` : ""}.`;
}

const found = new Map<string, string>();
const pending: string[] = [];
const visit = (name: string, fromDirectory: string): void => {
  const directory = resolvePackage(name, fromDirectory);
  if (!found.has(directory)) {
    found.set(directory, name);
    pending.push(directory);
  }
};
for (const name of Object.keys(readPackage(root).dependencies ?? {})) {
  visit(name, root);
}
visit(nativePackage, root);
while (pending.length > 0) {
  const directory = pending.pop() as string;
  for (const name of Object.keys(readPackage(directory).dependencies ?? {})) {
    visit(name, directory);
  }
}

const sections = [...found.keys()]
  .map((directory) => {
    const manifest = readPackage(directory);
    const license =
      typeof manifest.license === "string" ? manifest.license : (manifest.license?.type ?? "");
    return {
      title: `${manifest.name}@${manifest.version}${license ? ` (${license})` : ""}`,
      text: licenseText(directory, manifest, license),
    };
  })
  .sort((left, right) => left.title.localeCompare(right.title));

const bunVersion = Bun.version;
const lines = [
  "lazco is MIT licensed. This binary also contains the software below, under these licenses.",
  "",
  `bun@${bunVersion} (MIT, with bundled components under their own licenses)`,
  "The binary embeds the Bun runtime. Its license and the licenses of the components it",
  "bundles, among them JavaScriptCore (LGPL-2.1), are listed at",
  "https://bun.com/docs/project/licensing",
];
for (const section of sections) {
  lines.push("", "-".repeat(78), "", section.title, "", section.text);
}
process.stdout.write(`${lines.join("\n")}\n`);
