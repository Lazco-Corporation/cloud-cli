# Credentials

The CLI and `lazco mcp` use the same credential, of one of two methods:

- `token`: a Lazco API token, `lz_live_` and 64 lowercase hexadecimal characters. An admin key (`lz_admin_`) is refused before any request.
- `sso`: a sign-in with the Lazco account through the API's OpenID provider, as the public client `lazco-cli`. It holds a refresh token, and an access token of one hour that the CLI refreshes by itself, see "SSO sign-in".

## Which credential a run uses

`src/credentials/session.ts` picks the first of:

1. `LAZCO_TOKEN`. It goes to `--api-url`, or to the default `https://api.lazco.tw/v1`.
2. The profile named by `--profile`.
3. The profile named by `LAZCO_PROFILE`.
4. The current profile of the config file.

A profile's credential goes only to the profile's own API URL.
`--api-url` with another URL and a stored credential is `CLI_INVALID_INPUT`, so a mistyped or hostile URL cannot carry the token away.
With none of the four, a command that needs a credential is `CLI_NOT_LOGGED_IN`.

## The config file

`$XDG_CONFIG_HOME/lazco/config.json`, `~/.config/lazco/config.json` when unset, `%APPDATA%\lazco\config.json` on Windows.
It has mode 0600, is written to a temporary file and renamed, and is checked with the Zod schema in `src/config/configFile.ts`.

```json
{
  "version": 1,
  "currentProfile": "<profile name>",
  "profiles": {
    "<profile name>": {
      "apiUrl": "https://api.lazco.tw/v1",
      "organization": { "id": "<uuid>", "name": "<name>" },
      "method": "token",
      "credential": { "store": "keychain", "account": "<profile name>@<16 hexadecimal characters>" }
    }
  }
}
```

- A profile name is 1 to 64 letters, digits, `.`, `_` or `-`, and starts with a letter or a digit, because it also starts the keychain account.
- A profile without `--profile` is `default`.
- `method` is `token` or `sso`, and says what the store holds: the token, or the SSO record as JSON.
- `currentProfile` must name a profile. Logging out of the current profile leaves no current profile.
- A field this version does not know is kept, so an older CLI does not drop what a newer one wrote.
- A file that fails the schema is `CLI_INVALID_INPUT` naming the file.

## The keychain

`src/credentials/keychain.ts` stores the token with `@napi-rs/keyring`, under service `tw.lazco.cli` and the account that the profile's `credential.account` names.

- Each login makes a new account: the profile name, `@`, and 16 random hexadecimal characters, such as `default@3fa9c2d17b04e815`.
  So two config files with one profile name, through another `XDG_CONFIG_HOME` or `APPDATA`, never share an entry, and a token never reaches the API URL of the other file.
  The config file fails its schema when an account does not start with the name of its profile.
- Login writes the new entry, then the config file, and only then deletes the entry of the profile's previous login.
  When the config file cannot be written, it deletes the new entry, and the old login keeps working.
- A login that is killed halfway, or a delete of an old entry that fails, can leave an entry that no config file names.
  List the entries with the OS's own tool, and delete the ones that no `credential.account` names: `security dump-keychain | grep -B12 '"svce"<blob>="tw.lazco.cli"' | grep '"acct"'` on macOS, which prints the `"acct"` line of each entry, 12 lines above its service, `secret-tool search --all service tw.lazco.cli 2>&1 | grep -v '^secret = '` on Linux, which shows the `attribute.username` lines and any error but leaves out the `secret` lines that hold the credentials, and the Windows Credentials of the Credential Manager, whose names end in `.tw.lazco.cli`.

- macOS uses the login keychain, Windows the Credential Manager, Linux the Secret Service.
- Every entry pins the Linux store `secret-service`, so a token never lands in the kernel keyring, which a reboot clears.
- After a store, the value is read back. A keychain that throws, or loses the value, counts as no keychain, and the value goes into the config file with mode 0600: `{ "store": "file", "token": "<token>" }`, or `{ "store": "file", "sso": { <SSO record> } }`. Login and `auth status` say so.
- A failed read or delete of an existing entry is `CLI_INTERNAL`, and a failed delete keeps the profile.

### The compiled binary

The loader of `@napi-rs/keyring` finds its native package with `createRequire`, which `bun build --compile` does not follow.
So `src/credentials/nativeKeyring.ts` holds one literal `import("@napi-rs/keyring")`, and `scripts/build-binaries.sh` rewrites it per target into the target's package, such as `@napi-rs/keyring-darwin-arm64`, in a staged copy of `src/`.
The build fails when the placeholder or a target's native package is missing, so no binary falls back to the file store in silence.
Install every target's native package first with `bun install --frozen-lockfile --os='*' --cpu='*'`.

`bun build --compile` leaves the darwin-x64 binary with a signature that no longer matches the file, and macOS then refuses it the keychain.
So every macOS binary gets an ad-hoc signature, with `rcodesign` on Linux (`scripts/install-rcodesign.sh`) or `codesign` on macOS.

`.github/workflows/keychain.yml` proves the keychain and the refresh lock of the binary and of the npm package on all five targets, on every push to a branch that changes a file under its `paths`, and on every tag.

## Sign-in commands

`lazco auth login` picks the method:

- `--sso`, or any SSO option (`--device`, `--org`, `--read-only`, `--switch`): the SSO sign-in.
- `--with-token`: the token from stdin. It never asks.
- Neither, on a terminal: it asks on stderr, "Sign in with your browser" or "Paste an API token", and asks for a token with the input hidden.
- Neither, without a terminal, or `--with-token` with `--sso` or an SSO option, or `--switch` with `--org`: `CLI_INVALID_INPUT`, before any request.

It checks the new credential, the token or the SSO access token, with `GET /v1/whoami`, and stores nothing when that fails.
An SSO sign-in that `whoami` refuses is revoked, so it is not left in the user's list.
It prints `{ "profile", "method", "apiUrl", "organization": { "id", "name" }, "scope", "store", "current" }`, with `path` when the store is `file`.

`lazco auth status` prints `{ "profile", "method", "apiUrl", "store", "organization", "role", "scope", "expiresAt" }`, with `path` for the file store.
For `LAZCO_TOKEN`, `profile` and `store` are both `env`, and `method` is `token`.

`lazco auth logout` deletes the credential from its store and deletes the profile, and prints `{ "profile", "loggedOut": true }`.

- An SSO sign-in is revoked first, at the provider's revocation endpoint with the refresh token, which works after the access token has expired.
  When the revocation fails, the credential and the profile are still deleted, and logout fails with the error, `CLI_NETWORK` when the API cannot be reached, and says that the sign-in stays listed in the Cloud settings until it is revoked there or unused for 30 days.
- A pasted token stays valid, because `/v1/api-tokens` accepts a browser session only.
  stderr names the panel page that revokes it: the API host with `api` changed to `cloud`, such as `https://cloud-staging.lazco.tw/dashboard/api`.

`lazco profile list` prints one line per profile with `name`, `apiUrl`, `organization`, `method`, `store` and `current`, never the credential.
`lazco profile use <name>` makes a profile current.

## SSO sign-in

`src/sso/` holds the protocol. `src/credentials/ssoCredential.ts` holds the refresh.

### The provider

The endpoints come from the discovery document of the API in use, `<api url>/oidc/openid-configuration`, so `--api-url` also picks the provider, and staging needs nothing else.
Every endpoint must be `https://`, or `http://` to this machine for a test.
The client is `lazco-cli`, a public client with no secret: every OAuth request sends `client_id` and nothing else to authenticate.

### Which flow

The device flow (RFC 8628) runs with `--device`, when `SSH_CONNECTION` is set, or on Linux with neither `DISPLAY` nor `WAYLAND_DISPLAY`.
Otherwise the loopback flow (RFC 8252) runs.
Both send `scope` `openid lazco.read lazco.write`, or `openid lazco.read` with `--read-only`, and `device_name`, the host name and the platform, such as `build-01 (Linux)`, which the provider shows in the sign-in email and the signed-in products list.

### Loopback

1. Listen on `127.0.0.1` with port 0, so the OS picks a free port, or on `::1` when IPv4 loopback is missing. Never on the name `localhost`.
2. Open `authorization_endpoint` in the default browser, and print the URL on stderr too, with `response_type=code`, the redirect `http://127.0.0.1:<port>/callback`, a PKCE S256 challenge of a 32-byte verifier, a 16-byte random `state`, and `organization_hint` when there is one.
3. Answer the first `GET /callback` with a small page that has no external asset, then stop listening. Any other request gets 404.
4. Check that `state` matches and that `iss` equals the issuer, else `CLI_BAD_RESPONSE`, and the code is never used. An `error` such as `access_denied` is `CLI_NOT_LOGGED_IN` with `details.oauthError`.
5. Exchange the code with the verifier, the same redirect and `device_name`.

No callback within 10 minutes, the life of a pending request at the provider, is `CLI_TIMEOUT`.

### Device

1. Post to `device_authorization_endpoint`.
2. Print on stderr the verification URL, the user code, and the warning to enter the code only on that page.
3. Poll the token endpoint at the `interval` the provider gives, 5 seconds when it gives none. `authorization_pending` keeps polling, and every `slow_down` adds 5 seconds to the interval.
4. `access_denied` is `CLI_NOT_LOGGED_IN` with `details.oauthError`, and `expired_token` is `CLI_TIMEOUT`.

### Organization and access

- `--org <id>` sends `organization_hint`, so the consent screen preselects it.
- A sign-in on a profile that already holds an SSO sign-in to the same API sends that organization as the hint.
- `--switch` sends no hint, so the user picks again.
- A sign-in that replaces an SSO sign-in revokes the old one after the new one is stored, whatever the new method. When that fails, stderr says the old one stays listed. A sign-in that replaces a pasted token revokes nothing, because the panel manages the token.

### The stored record

One JSON value in the profile's store:

| Field | Holds |
|---|---|
| `signInId` | 16 random hexadecimal characters of this sign-in, which a refresh keeps. It names the `whoami` cache of the sign-in |
| `issuer` | The provider's issuer. A refresh refuses a discovery document that names another |
| `clientId` | `lazco-cli` |
| `organizationId` | The organization of the sign-in |
| `scope` | `read` or `read_write`, as granted |
| `accessToken`, `accessTokenExpiresAt` | The access token and its expiry, in epoch milliseconds of the wall clock |
| `refreshToken` | The current refresh token |

### Refresh

Before a request, the CLI and `lazco mcp` refresh an access token that expires within 60 seconds.
A request answered 401 refreshes once and is sent once more.

A refresh takes the profile's lock, `<config dir>/lazco/locks/<profile>.lock`, with `proper-lockfile`, and waits at most 30 seconds for it, else `CLI_TIMEOUT`.
Inside the lock it reads the stored record again, and uses it without a request when another process already stored a newer pair.
Otherwise it posts the refresh token, and stores the new pair before it releases the lock, in the keychain entry or the config file the profile names.
So two processes of one profile make one refresh between them, which `test/credentials/lock.test.ts` checks, and `test/keychain/lock-proof.mjs` checks in the npm package on Node 22 and in each compiled binary.
A lock left by a process that died goes stale after 10 seconds.

- `invalid_grant` means the sign-in has ended: the stored credential and the profile are deleted, and the error is `CLI_NOT_LOGGED_IN` with the command to sign in again.
- A refresh that cannot reach the API is `CLI_NETWORK`, and the credential is kept.
- A profile that another process signed out or signed in again in the meantime is `CLI_NOT_LOGGED_IN`. A running `lazco mcp` never moves to another sign-in by itself.

Login and logout take the same lock while they write the profile, so a refresh never writes a pair back into an entry that a login just replaced.

Every write of the config file reads, changes and writes it under one more lock, `<config dir>/lazco/locks/_config.lock`, which no profile name can share because a profile name starts with a letter or a digit.
So a refresh of a file-store profile and a write of another profile at the same moment both stay in the file.
A process takes the config lock inside a profile lock, never the other way, so the two locks never wait on each other in a circle.

## Where a credential never goes

A credential is an API token, an SSO refresh token or an SSO access token.

- stdout, stderr and every error: every value equal to a credential this run has held becomes `[REDACTED]`, the tokens of every refresh included. The device code of a device sign-in is treated the same.
- The `whoami` cache: its file is named by the SHA-256 of the token, or of `sso:<signInId>`, and holds the answer only.
- An MCP client's config: `lazco mcp install` writes a command and its arguments only.
- A tool result of `lazco mcp`.

`test/commands/secrecy.test.ts` runs every command and error path with a known fake token and checks that neither the token nor its last 8 characters appear anywhere but the file store.
`test/commands/sso.test.ts` checks the same for every token its fake provider issued, after every SSO sign-in, refresh, status and logout.
