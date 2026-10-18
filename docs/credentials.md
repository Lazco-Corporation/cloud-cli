# Credentials

The CLI and `lazco mcp` use the same credential: a Lazco API token, `lz_live_` and 64 lowercase hexadecimal characters.
An admin key (`lz_admin_`) is refused before any request.

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
      "credential": { "store": "keychain", "account": "<profile name>@<16 hexadecimal characters>" }
    }
  }
}
```

- A profile name is 1 to 64 letters, digits, `.`, `_` or `-`, and starts with a letter or a digit, because it also starts the keychain account.
- A profile without `--profile` is `default`.
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
  List the entries with the OS's own tool, and delete the ones that no `credential.account` names: `security dump-keychain | grep -A4 tw.lazco.cli` on macOS, `secret-tool search --all service tw.lazco.cli` on Linux, and the Windows Credentials of the Credential Manager, whose names end in `.tw.lazco.cli`.

- macOS uses the login keychain, Windows the Credential Manager, Linux the Secret Service.
- Every entry pins the Linux store `secret-service`, so a token never lands in the kernel keyring, which a reboot clears.
- After a store, the token is read back. A keychain that throws, or loses the token, counts as no keychain, and the token goes into the config file as `{ "store": "file", "token": "<token>" }` with mode 0600. Login and `auth status` say so.
- A failed read or delete of an existing entry is `CLI_INTERNAL`, and a failed delete keeps the profile.

### The compiled binary

The loader of `@napi-rs/keyring` finds its native package with `createRequire`, which `bun build --compile` does not follow.
So `src/credentials/nativeKeyring.ts` holds one literal `import("@napi-rs/keyring")`, and `scripts/build-binaries.sh` rewrites it per target into the target's package, such as `@napi-rs/keyring-darwin-arm64`, in a staged copy of `src/`.
The build fails when the placeholder or a target's native package is missing, so no binary falls back to the file store in silence.
Install every target's native package first with `bun install --frozen-lockfile --os='*' --cpu='*'`.

`bun build --compile` leaves the darwin-x64 binary with a signature that no longer matches the file, and macOS then refuses it the keychain.
So every macOS binary gets an ad-hoc signature, with `rcodesign` on Linux (`scripts/install-rcodesign.sh`) or `codesign` on macOS.

`.github/workflows/keychain.yml` proves the keychain of the binary and of the npm package on all five targets, on every push that touches the credential code or the build.

## Sign-in commands

`lazco auth login` asks for the token with the input hidden, or reads it from stdin with `--with-token`.
It checks the token with `GET /v1/whoami` and stores nothing when that fails.
It prints `{ "profile", "apiUrl", "organization": { "id", "name" }, "store", "current" }`, with `path` when the store is `file`.

`lazco auth status` prints `{ "profile", "apiUrl", "store", "organization", "role", "scope", "expiresAt" }`, with `path` for the file store.
For `LAZCO_TOKEN`, `profile` and `store` are both `env`.

`lazco auth logout` deletes the token from its store and deletes the profile, and prints `{ "profile", "loggedOut": true }`.
The token stays valid, because `/v1/api-tokens` accepts a browser session only.
stderr names the panel page that revokes it: the API host with `api` changed to `cloud`, such as `https://cloud-staging.lazco.tw/dashboard/api`.

`lazco profile list` prints one line per profile with `name`, `apiUrl`, `organization`, `store` and `current`, never the token.
`lazco profile use <name>` makes a profile current.

## Where a credential never goes

- stdout, stderr and every error: every value equal to the active credential becomes `[REDACTED]`.
- The `whoami` cache: its file is named by the credential's SHA-256 and holds the answer only.
- An MCP client's config: `lazco mcp install` writes a command and its arguments only.
- A tool result of `lazco mcp`.

`test/commands/secrecy.test.ts` runs every command and error path with a known fake token and checks that neither the token nor its last 8 characters appear anywhere but the file store.
