> **Start your agent at the workspace root, not here.**
>
> This repo lives in `lazco-workspace/repos/`. Shared rules, shared skills, and
> every openspec spec load only from the workspace root, because the skill
> search stops at a git repo root and this repo is one.
>
> A session started here loads none of them, and nothing warns you.
>
> Open the agent in `lazco-workspace/`, then work by path:
> `git -C repos/cloud-cli status`.

# AGENTS.md

`@lazco/cli` is the `lazco` command and its local MCP server, `lazco mcp`.
Its commands and its MCP tools are generated at run time from the API's `GET /v1/spec`, so a new API operation needs no release here.
`README.md` is for users. The `docs/` files are for the people who change this code.

## Commands

Run them from the repo, in a subshell from the workspace root: `(cd repos/cloud-cli && bun run check)`.

| Command | Does |
|---|---|
| `bun install --frozen-lockfile` | Install the dependencies |
| `bash scripts/setup-hooks.sh` | Point git at `.githooks/`, and check that `bun`, `git`, `gitleaks` and Biome are installed |
| `bun run check` | Biome lint and format check |
| `bun run check:fix` | Biome with fixes written |
| `bun run type-check` | `tsc --noEmit` |
| `bun run test:unit` | Every test except `test/contract/`, offline |
| `infisical run --env=staging --path=/ci --projectId 0248054f-6632-402a-b7b9-290b920a4462 -- bun run test:contract` | Build, then the contract tests against staging |
| `bun run build` | `dist/` of the npm package |
| `bun install --frozen-lockfile --os='*' --cpu='*' && bun run build:binaries` | The five binaries, their archives and `SHA256SUMS` in `build/binaries/`. `VERSION` is required |
| `bun eval/mcp/run.ts --tier read` | The MCP evaluation set through `pi`, see `docs/testing.md` |
| `bash scripts/release.sh <patch\|minor\|major>` | Cut a release, see `docs/release.md` |

The pre-commit hook runs gitleaks and Biome on the staged files.
The pre-push hook runs gitleaks, the check, the type check and the unit tests.

## Where things are

| Directory | Holds |
|---|---|
| `src/core/spec/` | Loading, caching and checking the spec |
| `src/core/generate/` | Operations to input schemas, the command tree and the tool list |
| `src/core/request/` | The input guard, the schema check, the client with its retries and rate cap, the task wait, the ETag flow and pagination |
| `src/shell/` | Global flags, output, `--describe`, `--dry-run`, confirmation and feature hiding |
| `src/commands/` | The hand-written commands: `auth`, `profile`, `mcp` and `mcp install` |
| `src/mcp/` | The stdio MCP server, its tiers, and the client config writers |
| `src/config/` | Paths, the config file and its Zod schema |
| `src/credentials/` | The keychain store, the file store, the credential order, the SSO credential with its refresh, and the profile lock |
| `src/sso/` | The SSO sign-in: discovery, the loopback and device flows, the OAuth requests, and revocation |
| `test/` | Unit tests, with spec fixtures in `test/fixtures/` and a fake API on `127.0.0.1` |
| `test/contract/` | Tests of the built CLI and the MCP server against staging |
| `test/keychain/` | The keychain proof and the refresh lock proof that `.github/workflows/keychain.yml` runs on each target |
| `eval/mcp/` | The MCP evaluation set and its runner |
| `scripts/` | Install, binary build, release and hook setup scripts |
| `docs/` | How the code works, in depth |

## Invariants

- stdout holds only the answer: one JSON object, NDJSON for a list, or MCP messages for `lazco mcp`. Every warning, hint and error goes to stderr.
- An error is one line `{"error":{...}}` on stderr and exit code 1. The `CLI_` codes in `src/core/errors.ts` are a semver contract: adding, renaming or removing one is a release note.
- No credential reaches any output, log, cache file or MCP client config. A stored credential goes only to the API URL of its profile.
- Only sign-in, profiles and credentials, and `mcp` are hand-written commands. An upload is hand-written behavior on a generated command, registered in `KNOWN_UPLOADERS`. A wrong command or tool name is fixed in the backend's `x-lazco`, never here.
- `src/credentials/nativeKeyring.ts` keeps its one literal `import("@napi-rs/keyring")`, which `scripts/build-binaries.sh` rewrites per target. Without it every binary falls back to the file store and nothing fails.
- An `x-lazco` value this version does not know skips its operation with one warning. An unknown key is ignored.
- MCP never offers a `spend` tool, and offers a `destructive` tool only when its operation has `confirm`.
- Every job of `.github/workflows/ci.yml` and `.github/workflows/release-npm.yml` runs on `ubuntu-latest`. No secret lives in GitHub: CI reads Infisical `lazco-cloud-cli` through OIDC.
- The MCP evaluation set runs locally, never in CI, and its results never go into the repo.
