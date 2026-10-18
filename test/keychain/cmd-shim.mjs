#!/usr/bin/env node
/**
 * The Windows proof of `lazco mcp install` for the clients it adds through
 * their own CLI: fake `claude.cmd` and `codex.cmd` shims, made the way an npm
 * install makes them (`node <script> %*`), record the arguments they get, and
 * the proof checks that each one arrived whole, the JSON of `claude mcp
 * add-json` included.
 *
 * Usage: node test/keychain/cmd-shim.mjs <lazco command...>
 * Runs on Windows only. Plain JavaScript, so it runs on a bare Node 22.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const [command, ...commandArguments] = process.argv.slice(2);
if (process.platform !== "win32" || !command) {
  console.error("usage on Windows: node test/keychain/cmd-shim.mjs <lazco command...>");
  process.exit(2);
}

function fail(message) {
  console.error(`cmd shim proof: FAIL: ${message}`);
  process.exit(1);
}

const bin = mkdtempSync(join(tmpdir(), "lazco-cmd-shim-"));
const home = mkdtempSync(join(tmpdir(), "lazco-cmd-home-"));
const record = join(bin, "calls.jsonl");
writeFileSync(
  join(bin, "record.cjs"),
  `require("node:fs").appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
);
for (const name of ["claude", "codex"]) {
  writeFileSync(join(bin, `${name}.cmd`), `@node "%~dp0record.cjs" ${name} %*\r\n`);
}

function run(args) {
  return new Promise((resolve, reject) => {
    // A `lazco.cmd` shim of a global npm install needs a shell to start.
    const child = spawn(command, [...commandArguments, ...args], {
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        USERPROFILE: home,
        HOME: home,
        APPDATA: join(home, "appdata"),
        LOCALAPPDATA: join(home, "localappdata"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: !/\.exe$/i.test(command),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

try {
  for (const client of ["claude-code", "codex"]) {
    const result = await run(["mcp", "install", "--client", client, "--allow-writes"]);
    if (result.code !== 0) {
      fail(`mcp install --client ${client} exited ${result.code}: ${result.stderr}`);
    }
  }
  const calls = readFileSync(record, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const addJson = calls.find((call) => call[0] === "claude" && call[2] === "add-json");
  if (!addJson) {
    fail(`claude mcp add-json was never called: ${JSON.stringify(calls)}`);
  }
  const entry = JSON.parse(addJson[4]);
  if (entry.type !== "stdio" || !entry.args.includes("--allow-writes")) {
    fail(`claude mcp add-json got a wrong entry: ${addJson[4]}`);
  }
  const codexAdd = calls.find((call) => call[0] === "codex" && call[2] === "add");
  if (codexAdd?.at(-1) !== "--allow-writes" || !codexAdd.includes("--")) {
    fail(`codex mcp add got wrong arguments: ${JSON.stringify(codexAdd)}`);
  }
  console.log(`cmd shim proof: OK for ${command}: ${calls.length} calls arrived whole`);
} finally {
  rmSync(bin, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
