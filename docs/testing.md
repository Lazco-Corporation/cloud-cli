# Testing

| Suite | Where | Runs | Needs |
|---|---|---|---|
| Unit | `test/`, except `test/contract/` | `bun run test:unit`, the pre-push hook, `.github/workflows/ci.yml` | Nothing. No network but `127.0.0.1` |
| Contract | `test/contract/` | `bun run test:contract`, the `contract` job of `.github/workflows/ci.yml` | The two staging tokens |
| Keychain | `test/keychain/proof.mjs` | `.github/workflows/keychain.yml` on the five targets | A runner of each OS |
| Refresh lock | `test/keychain/lock-proof.mjs` | `.github/workflows/keychain.yml` on the five targets, for the binary and the npm package | A runner of each OS |
| Windows `.cmd` shims of `claude` and `codex` | `test/keychain/cmd-shim.mjs` | `.github/workflows/keychain.yml` on `windows-2025` | A Windows runner |
| MCP evaluation | `eval/mcp/` | By hand, never in CI | `pi`, a model, the staging profile |

## Unit tests

They use `bun test`.
The spec fixtures in `test/fixtures/` cover every `x-lazco` case: `test/fixtures/surface.json` holds the operations the generator keeps, and `test/fixtures/skips.json` the ones it skips.
`test/fixtures/pages.json` holds the Pages deploy routes, and `test/helpers/pagesApi.ts` serves them with a fake storage for the signed PUTs, so a test runs the uploader end to end. `test/helpers/fakeStorage.ts` is a storage endpoint alone, for the upload engine.
`test/helpers/fakeApi.ts` is an API on `127.0.0.1` that records every request.
`test/helpers/fixtureApi.ts` serves the `surface` fixture as its spec and answers its operations, and a test may change its features, scope, spec or ETag while it runs.
`test/helpers/fakeProvider.ts` is the OpenID provider of the SSO sign-in on `127.0.0.1`: discovery, the authorize redirect with a fake browser, the code, device and refresh grants with rotation, revocation and `whoami`. A test sets what the browser does, the answers of the device grant, the token lifetime and a delay of the refresh answer.
No test opens a real browser: `runInProcess` passes a browser that opens nothing, unless a test passes the fake provider's.

Tests that matter for a contract run the CLI as a child process (`runLazco`), or on a pseudo-terminal (`runLazcoOnTerminal`).
The MCP tests drive the server with the SDK's `Client`: over stdio as a child process in `test/mcp/stdio.test.ts`, and in memory in `test/mcp/tools.test.ts`, with a scheduler the test ticks by hand for the 5-minute check.

No test compares `--describe` output against a stored copy, because the output follows the spec.
No test touches the real keychain: an in-memory keychain stands in, except in `test/credentials/keychain.test.ts`, which only loads the native binding.

## Contract tests

They run the built CLI on Node and the MCP server against `https://api-staging.lazco.tw/v1`, with two tokens of the staging organization "CLI Contract Test", which exists only for them:

| Variable | Scope |
|---|---|
| `LAZCO_CONTRACT_TOKEN` | `read_write` |
| `LAZCO_CONTRACT_READ_TOKEN` | `read` |

Both are in Infisical `lazco-cloud-cli`, `staging`, `/ci`.
Run them locally with:

```sh
infisical run --env=staging --path=/ci --projectId 0248054f-6632-402a-b7b9-290b920a4462 -- bun run test:contract
```

`LAZCO_CONTRACT_API_URL` points them at another API, such as a local backend.
`LAZCO_CONTRACT_SPEND=1` adds the one test that spends: it buys a Pages pack twice with one `--idempotency-key`, checks the replay, and deletes the pack.
A pack costs a month of it with no refund, so the `contract` job sets it only on a push to `main`.
The organization needs the `pages` feature and a balance of one pack month.
The test deletes every pack of the organization that still renews, before and after the purchase, so never run it by hand while a `contract` job of `main` runs.

They read every `read` operation that needs no input, round-trip an SSH key, check the 401, 404, guard and schema errors, walk both list shapes with `--page-all`, check that every `spend` operation requires `Idempotency-Key`, and check the MCP tiers with both tokens.
Every SSH key they create is named `cli-contract-<suffix>`, and each run deletes every such key at its start and its end, so a cancelled run leaves nothing for long.
The `contract` job runs one at a time, because every run writes to the same organization.
`async` and `etag` are checked by the fixtures only, because a staging deploy costs credit and a DNS write needs a delegated zone.

## The MCP evaluation set

`eval/mcp/tasks.yaml` holds 44 tasks in natural language against the contract organization.
Each has the tier it needs, the tools a good run calls, and a CLI command whose output proves the answer.
`eval/mcp/run.ts` runs them through `pi` and grades each one.

The Pages tasks deploy to an active Pages site of the contract organization, named `cli-eval` unless `--pages-site <name>` names another.

1. Sign in a profile with the contract token: pipe it from `infisical run` into `lazco --profile staging --api-url https://api-staging.lazco.tw auth login --with-token`.
2. Copy `~/.pi/agent/mcp.json`, if it exists.
3. Run `lazco mcp install --client pi --profile staging`.
4. Run `bun run build`, then `bun eval/mcp/run.ts --tier read`.
5. Run `lazco mcp install --client pi --profile staging --allow-writes`, then `bun eval/mcp/run.ts --tier write`.
6. Put the copy of `~/.pi/agent/mcp.json` back.

The runner prints a JSON summary with the pass list and each failure.
The bar is 40 of 44.
The results go into the pull request, never into the repo, because they depend on the model and the day.
A weak result is usually a weak `summary` or `description` in the spec, and the fix belongs in `cloud-backend`.
