# Architecture

`lazco` has no command table of its own.
Every API command and every MCP tool comes from the API's spec, read at run time.
The hand-written part is the shell around it: sign-in, profiles, output, and the MCP server.

## One run of a command

1. `src/shell/globalFlags.ts` takes the global flags out of the arguments, wherever they stand.
2. `src/commands/registry.ts` is asked first. A hand-written command (`auth`, `profile`, `mcp`) runs without the spec.
3. `src/credentials/session.ts` picks the API URL and the credential source, in the order of `docs/credentials.md`. An SSO sign-in becomes an `SsoCredential` (`src/credentials/ssoCredential.ts`), which refreshes its access token as the run goes.
4. `src/core/spec/loader.ts` gets the spec of that API URL, from the cache or from `GET /v1/spec`, see `docs/spec-contract.md`.
5. `src/core/generate/operations.ts` turns each operation into a command, an input schema and at most one tool. `src/core/generate/tree.ts` resolves the command words.
   An unknown word refreshes the spec once, so a new operation works at once.
6. `src/shell/input.ts` builds the one input object from positionals, flags and `--json`.
7. `src/core/request/build.ts` runs the path guard (`src/core/request/guard.ts`) and the JSON Schema check (`src/core/request/validate.ts`, Ajv), then splits the input into path, query, `If-Match` and body.
8. `src/shell/confirm.ts` asks for a `destructive` or `spend` command, or needs `--yes`.
   A `spend` command first sends its quote operation and shows the quote on stderr (`src/core/quote.ts`), unless `--quote-id` and `--expected-amount` give one.
   Its request carries the quote's `quoteId` and `amount` as `expectedAmount`, see "Spend operations" in `docs/spec-contract.md`.
9. `src/core/request/execute.ts` sends it through `src/core/request/client.ts`, reads the ETag first for `concurrency: etag`, and waits for an `async: task` operation.
   An operation with `upload` goes to its uploader in `src/uploads/` instead, which sends its own requests through the same client, see "Uploaders" in `docs/spec-contract.md`.
10. `src/shell/output.ts` writes the answer to stdout, or the error to stderr.

The MCP server runs steps 4, 5, 7 and 9 of the same code, so a command and its tool cannot drift apart.

## The request policy

`src/core/request/client.ts` holds it, for commands and tools alike:

- A request times out after 60 seconds with `CLI_TIMEOUT`, and is never sent again after that.
- A GET is tried three times in all after a network error, 502, 503, 504 or 429, about 0.5 then 1 second apart with jitter.
- A request with `Idempotency-Key` is tried five times in all, with the same key, 1, 2, 4 and 8 seconds apart.
  It is sent again after a network error, a 502, 503 or 504 whose body is not the API error shape, `409 IDEMPOTENCY_KEY_IN_PROGRESS` and a 429, and after no other answer.
  An answer with `Idempotent-Replayed: true` is the key's stored one and is never sent again.
- Any other request is sent once.
- `Retry-After` up to 60 seconds on an answer that is retried is waited for instead.
  A longer one returns the answer at once.
- One request starts every 100 milliseconds per process, so no second holds more than 10.
- A request with an SSO credential refreshes an access token that expires within 60 seconds first. A 401 to it refreshes once and sends the request once more.
- An API error passes through with its status and every field. A body with both `error` and `message` keeps `message`, the specific one.
- Every value equal to a credential of the run, an SSO token of any refresh among them, is replaced with `[REDACTED]` before any error or answer is written.
- An OAuth endpoint of the provider takes a form body (`application/x-www-form-urlencoded`), sent with no bearer, see `src/sso/oauth.ts`.

## Output

| Stream | Holds |
|---|---|
| stdout | The answer only: one JSON object, NDJSON for a list, the bare version for `--version`, usage text for `--help`, MCP messages for `lazco mcp` |
| stderr | One error line `{"error":{"code","message",...}}`, and every other line starting with `lazco: `, such as a warning, the next-page hint or task progress |

A list is the answer of an operation with `paginate`, or a JSON array.
Any other answer is one object, even one that holds an array, because guessing which array is the list would change the output when the API adds a field.
`--page-all` writes nothing until every page is read, so a failure on a later page leaves stdout empty.
`--human` writes a table or `key: value` lines, with color only on a terminal and without `NO_COLOR`.
The exit code is 0, or 1 on any error.

## The MCP server

`src/mcp/server.ts` uses the low-level `Server` of `@modelcontextprotocol/sdk` with `StdioServerTransport`.

- Before it reads any MCP message, it reads `GET /v1/whoami` and the spec, because the instructions of `initialize` need both. With no credential it exits with `CLI_NOT_LOGGED_IN` and writes nothing to stdout.
- It declares `tools` with `listChanged` only: no resources and no prompts.
- `src/mcp/tools.ts` picks the tools by tier: `read` always, `write` and confirmed `destructive` with `--allow-writes` on a token that can write, `spend` with `--allow-spend` too, and none whose feature is off.
  The annotations come from `kind` and the method.
- A quote tool registers only with its spend tool, never alone.
  A spend tool requires `quoteId` and `expectedAmount`, and its description names its quote tool.
- `--only <prefix>`, repeatable, keeps only the tools whose `operation.command` starts with the words of a prefix, word by word.
  It runs before the feature check and the tiers, so it can only remove a tool, and the instructions name only the hidden features that hide a tool under the prefixes, such as the feature of the quote tool that a spend tool under the prefixes needs.
  The quote tool of a kept spend tool stays even outside the prefixes.
  The task reader stays when a kept tool has `async: task`, so no description names a tool that is not offered.
  When the task reader's own feature is off, the instructions name that feature instead.
  The instructions name the prefixes, and say that the quote tools and the task tool those tools need come too.
  `billing_get_quote` gets no such rule, because no kept tool needs it.
  At start, a prefix that matches no operation with a tool name, whatever its tier or feature, fails with `CLI_INVALID_INPUT`.
  The instructions of `initialize` cannot change, so when a later spec drops a prefix, the 5-minute check writes one warning to stderr and replaces the tools.
  `--only` filters this local server only. The credential can still call every API it could call before.
- When the client declared `elicitation`, a spend tool call reads the quote with `GET /v1/billing/quotes/{quoteId}`.
  It refuses a quote of another operation, a quote that is not `open`, and an `expectedAmount` that is not the quote's amount.
  Then it asks the user one required boolean, and sends the spend only on `accept` with `confirm` true.
  A client that declared URL elicitation only cannot answer a form, so its spend calls answer `CLI_CONFIRM_REQUIRED`.
- An upload tool runs its uploader to the end, and sends `notifications/progress` when the call carries a progress token. A cancel of the call is an interrupt.
- A tool call returns one `text` item with the JSON answer, or `isError` with the error object. An async tool returns `{ "accepted": <202 body>, "taskTool": "tasks_get" }` at once. A paginated tool returns one page as the API sent it.
- Every 5 minutes while a client is connected, it checks the spec by ETag and reads `whoami` again, and sends `notifications/tools/list_changed` only when the listed tools changed.
- The `User-Agent` is `lazco-cli/<version> (mcp)` until `initialize` names the client, then `lazco-cli/<version> (mcp; <client>/<version>)`.

`lazco mcp install` writes the server into a client's configuration, see `docs/mcp-clients.md`.

### Operations with no MCP tool

An operation whose `x-lazco.mcp` is `false` gets a CLI command and no MCP tool, whatever flags `lazco mcp` gets.
The backend decides which operations those are, never this repo.
The base rule is that MCP offers what the API offers, except an operation whose answer holds a credential.
The backend also keeps some groups of operations off MCP on purpose, stricter than that rule, each for its own reason, for example a standing charge or a person's consent or signature.
The groups, the reason for each, their routes, and the steps to put a group back on MCP are in `docs/api-machine-spec.md` of `cloud-backend`, section "`mcp: false`".
A spend operation with an MCP name follows the spend tier above.

## Builds

`bun run build` writes `dist/` for Node 22 with every dependency external, so npm installs them with their licenses.
`scripts/build-binaries.sh` compiles the five binaries with everything embedded, with `THIRD_PARTY_NOTICES.txt` in each archive.
`docs/credentials.md` explains the keychain rewrite each binary needs.
