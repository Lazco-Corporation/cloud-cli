#!/usr/bin/env node
/**
 * The refresh lock proof of `keychain.yml`: signs in with the device flow
 * against a fake provider on 127.0.0.1, whose first access token expires in
 * 30 seconds, runs two `auth status` at once, and checks that the provider got
 * one refresh request and both runs succeeded. Then logout revokes the
 * sign-in. The credential goes to the OS keychain where there is one.
 *
 * Usage: node test/keychain/lock-proof.mjs <lazco command and its first arguments...>
 *   node test/keychain/lock-proof.mjs build/binaries/darwin-arm64/lazco
 *   node test/keychain/lock-proof.mjs node dist/cli.js
 *
 * PROOF_PROFILE names the profile, `lock-proof` by default. Plain
 * JavaScript, so it runs on a bare Node 22 next to the npm package.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const profile = process.env.PROOF_PROFILE || "lock-proof";
const [command, ...commandArguments] = process.argv.slice(2);
if (!command) {
  console.error("usage: node test/keychain/lock-proof.mjs <lazco command...>");
  process.exit(2);
}

function fail(message) {
  console.error(`lock proof: FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

/** Runs a command to its end without a shell, and keeps its output. */
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
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
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const DEVICE_CODE = "lock-proof-device-code-0123456789";
/** Every token and code issued, which no output may hold. */
const issued = [DEVICE_CODE];
/** The access tokens `whoami` accepts: the newest pair's only, as after a rotation. */
const liveAccessTokens = new Set();
const refreshTokens = new Map();
let refreshRequests = 0;
let revokeRequests = 0;
let origin = "";

/** A token answer. The sign-in's first access token expires in 30 seconds, a refreshed one in an hour. */
function mint(expiresIn) {
  const accessToken = randomBytes(32).toString("hex");
  const refreshToken = randomBytes(32).toString("base64url");
  issued.push(accessToken, refreshToken);
  liveAccessTokens.add(accessToken);
  refreshTokens.set(refreshToken, { rotated: false, accessToken });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    refresh_token: refreshToken,
    scope: "openid lazco.read lazco.write",
  };
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body === undefined ? "" : JSON.stringify(body));
}

const server = createServer((request, response) => {
  let text = "";
  request.on("data", (chunk) => {
    text += chunk;
  });
  request.on("end", () => {
    const form = Object.fromEntries(new URLSearchParams(text));
    const route = `${request.method} ${request.url}`;
    if (route === "GET /v1/oidc/openid-configuration") {
      send(response, 200, {
        issuer: `${origin}/issuer`,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/v1/oidc/token`,
        device_authorization_endpoint: `${origin}/v1/oidc/device_authorization`,
        revocation_endpoint: `${origin}/v1/oidc/revoke`,
      });
    } else if (route === "POST /v1/oidc/device_authorization") {
      send(response, 200, {
        device_code: DEVICE_CODE,
        user_code: "BCDF-GHJK",
        verification_uri: `${origin}/issuer/device`,
        expires_in: 600,
        interval: 1,
      });
    } else if (route === "POST /v1/oidc/token" && form.grant_type?.endsWith(":device_code")) {
      // Inside the CLI's 60-second margin, so the next request refreshes first.
      send(response, 200, mint(30));
    } else if (route === "POST /v1/oidc/token" && form.grant_type === "refresh_token") {
      refreshRequests += 1;
      const current = refreshTokens.get(form.refresh_token);
      // Slow, so the second process reaches the lock while the first holds it.
      setTimeout(() => {
        if (!current || current.rotated) {
          send(response, 400, { error: "invalid_grant" });
          return;
        }
        current.rotated = true;
        // The pre-refresh access token stops working, so a process that kept it would fail.
        liveAccessTokens.delete(current.accessToken);
        send(response, 200, mint(3600));
      }, 1500);
    } else if (route === "POST /v1/oidc/revoke") {
      revokeRequests += 1;
      send(response, 200);
    } else if (route === "GET /v1/whoami") {
      const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!liveAccessTokens.has(bearer)) {
        send(response, 401, { error: "Invalid token", code: "UNAUTHORIZED" });
        return;
      }
      send(response, 200, {
        organization: { id: "org-proof", name: "Lock Proof" },
        role: "owner",
        principal: { kind: "product_session", clientId: "lazco-cli", scope: "read_write" },
        features: {},
      });
    } else {
      send(response, 404, { error: "Not found", code: "NOT_FOUND" });
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const apiUrl = `${origin}/v1`;

const home = mkdtempSync(join(tmpdir(), "lazco-lock-proof-"));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_CACHE_HOME: join(home, "cache"),
  APPDATA: join(home, "appdata"),
  LOCALAPPDATA: join(home, "localappdata"),
};
delete env.LAZCO_TOKEN;
delete env.LAZCO_PROFILE;
// A Windows `lazco.cmd` shim of a global npm install needs a shell to start.
const shell = process.platform === "win32" && !/\.exe$/i.test(command);
const lazco = (args) =>
  run(command, [...commandArguments, ...args, "--profile", profile], { env, shell });

let signedIn = false;
try {
  const login = await lazco(["auth", "login", "--device", "--api-url", apiUrl]);
  if (login.code !== 0) {
    fail(`login exited ${login.code}: ${login.stderr.trim()}`);
  }
  signedIn = true;
  console.log(`login: ${login.stdout.trim()}`);

  const [first, second] = await Promise.all([lazco(["auth", "status"]), lazco(["auth", "status"])]);
  for (const [name, result] of [
    ["first", first],
    ["second", second],
  ]) {
    if (result.code !== 0) {
      fail(`the ${name} auth status exited ${result.code}: ${result.stderr.trim()}`);
    }
  }
  console.log(`two auth status runs exited 0, with ${refreshRequests} refresh request(s)`);
  if (refreshRequests !== 1) {
    fail(`the provider got ${refreshRequests} refresh requests, not 1`);
  }

  const logout = await lazco(["auth", "logout"]);
  if (logout.code !== 0 || revokeRequests !== 1) {
    fail(
      `logout exited ${logout.code} with ${revokeRequests} revoke request(s): ${logout.stderr.trim()}`,
    );
  }
  signedIn = false;
  for (const token of issued) {
    for (const result of [login, first, second, logout]) {
      if (`${result.stdout}${result.stderr}`.includes(token.slice(-8))) {
        fail("a token reached the output");
      }
    }
  }
  console.log(`lock proof: PASS on ${process.platform}-${process.arch} with ${command}`);
} finally {
  // A proof that failed after login leaves its keychain entry, which logout removes.
  if (signedIn) {
    await lazco(["auth", "logout"]).catch(() => undefined);
  }
  server.close();
  rmSync(home, { recursive: true, force: true });
}
