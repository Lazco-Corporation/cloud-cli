#!/usr/bin/env node
/**
 * The keychain proof of `keychain.yml`: signs in with a fake token against a
 * fake `whoami` on 127.0.0.1, checks that `auth status` reports `keychain`,
 * that the OS's own tool finds the entry, that the config file holds no
 * token, and that logout removes the entry.
 *
 * Usage: node test/keychain/proof.mjs <lazco command and its first arguments...>
 *   node test/keychain/proof.mjs build/binaries/darwin-arm64/lazco
 *   node test/keychain/proof.mjs lazco
 *
 * PROOF_PROFILE names the profile, `keychain-proof` by default. On Linux it
 * needs a running, unlocked Secret Service and `secret-tool`.
 * Plain JavaScript, so it runs on a bare Node 22 next to the npm package.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVICE = "tw.lazco.cli";
const TOKEN = `lz_live_${"0".repeat(48)}${"c0ffee00".repeat(2)}`;
const profile = process.env.PROOF_PROFILE || "keychain-proof";
const [command, ...commandArguments] = process.argv.slice(2);
if (!command) {
  console.error("usage: node test/keychain/proof.mjs <lazco command...>");
  process.exit(2);
}

function fail(message) {
  console.error(`keychain proof: FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

/** Runs a command to its end without a shell, with an optional stdin, and keeps its output. */
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: options.shell ?? false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

/** True when the OS's own tool finds the entry of the profile. */
async function osToolFinds() {
  if (process.platform === "darwin") {
    const result = await run("security", ["find-generic-password", "-s", SERVICE, "-a", profile]);
    return result.code === 0;
  }
  if (process.platform === "linux") {
    const result = await run("secret-tool", ["lookup", "service", SERVICE, "username", profile]);
    return result.code === 0 && result.stdout.trim() === TOKEN;
  }
  if (process.platform === "win32") {
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LazcoCredentials {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredEnumerate(string filter, int flags, out int count, out IntPtr credentials);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr buffer);
  public static string[] Targets(string filter) {
    int count; IntPtr list;
    // A filter takes a trailing "*" only, so the caller enumerates all and filters itself.
    if (!CredEnumerate(filter, filter == null ? 1 : 0, out count, out list)) { return new string[0]; }
    var targets = new string[count];
    for (int index = 0; index < count; index++) {
      var item = Marshal.ReadIntPtr(list, index * IntPtr.Size);
      var credential = (CREDENTIAL)Marshal.PtrToStructure(item, typeof(CREDENTIAL));
      targets[index] = credential.TargetName + "|" + credential.UserName;
    }
    CredFree(list);
    return targets;
  }
}
'@
[LazcoCredentials]::Targets($null) | Where-Object { $_ -like '*${SERVICE}*' } | ForEach-Object { $_ }
`;
    const result = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    if (result.code !== 0) {
      fail(`the PowerShell credential reader failed: ${result.stderr.trim()}`);
    }
    console.log(`credential manager entries: ${result.stdout.trim() || "none"}`);
    return result.stdout.split(/\r?\n/).some((line) => line.includes(profile));
  }
  return fail(`no OS tool is known for ${process.platform}`);
}

const server = createServer((request, response) => {
  const signedIn = request.headers.authorization === `Bearer ${TOKEN}`;
  if (request.url === "/v1/whoami" && signedIn) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        organization: { id: "org-proof", name: "Keychain Proof" },
        role: "owner",
        principal: { kind: "api_token", scope: "read", expiresAt: null },
        features: {},
      }),
    );
    return;
  }
  response.writeHead(signedIn ? 404 : 401, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "no", code: signedIn ? "NOT_FOUND" : "UNAUTHORIZED" }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}/v1`;

const home = mkdtempSync(join(tmpdir(), "lazco-keychain-proof-"));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_CACHE_HOME: join(home, "cache"),
  APPDATA: join(home, "appdata"),
  LOCALAPPDATA: join(home, "localappdata"),
};
delete env.LAZCO_TOKEN;
delete env.LAZCO_PROFILE;
const configPath =
  process.platform === "win32"
    ? join(env.APPDATA, "lazco", "config.json")
    : join(env.XDG_CONFIG_HOME, "lazco", "config.json");
// A Windows `lazco.cmd` shim of a global npm install needs a shell to start.
const shell = process.platform === "win32" && !/\.exe$/i.test(command);
const lazco = (args, input) =>
  run(command, [...commandArguments, ...args, "--profile", profile], { env, input, shell });

try {
  if (await osToolFinds()) {
    fail(`an entry for ${profile} already exists before the proof`);
  }

  const login = await lazco(["auth", "login", "--with-token", "--api-url", apiUrl], TOKEN);
  if (login.code !== 0) {
    fail(`login exited ${login.code}: ${login.stderr.trim()}`);
  }
  const loggedIn = JSON.parse(login.stdout);
  console.log(`login: ${login.stdout.trim()}`);
  if (loggedIn.store !== "keychain") {
    fail(`login stored the token in ${loggedIn.store}: ${login.stderr.trim()}`);
  }

  const status = await lazco(["auth", "status"]);
  console.log(`auth status: ${status.stdout.trim()}`);
  if (status.code !== 0 || JSON.parse(status.stdout).store !== "keychain") {
    fail(`auth status did not report keychain: ${status.stderr.trim()}`);
  }
  if (readFileSync(configPath, "utf8").includes(TOKEN.slice(-8))) {
    fail("the config file holds the token");
  }
  if (!(await osToolFinds())) {
    fail("the OS tool does not find the entry after login");
  }
  console.log("the OS tool finds the entry after login");

  const logout = await lazco(["auth", "logout"]);
  if (logout.code !== 0) {
    fail(`logout exited ${logout.code}: ${logout.stderr.trim()}`);
  }
  if (await osToolFinds()) {
    fail("the OS tool still finds the entry after logout");
  }
  console.log("the OS tool finds nothing after logout");
  console.log(`keychain proof: PASS on ${process.platform}-${process.arch} with ${command}`);
} finally {
  server.close();
  rmSync(home, { recursive: true, force: true });
}
