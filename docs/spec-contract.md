# The spec contract

The CLI reads the API's OpenAPI 3.1 spec at `GET /v1/spec`, and the `x-lazco` object of each operation decides the command, the tool and how a call behaves.
The backend owns the names, so a wrong command or tool name is fixed in the backend's `x-lazco`, never here.

## The cache

The spec of an API URL is cached at `<cache dir>/lazco/spec/<sha256 of the API URL>.json` with its ETag and the time it was checked.
The cache dir is `$XDG_CACHE_HOME`, `~/.cache` when unset, and `%LOCALAPPDATA%` on Windows.

- A copy younger than 10 minutes is used with no request.
- An older one is checked with `If-None-Match`, and a 304 keeps it.
- A command name the copy lacks refreshes it once in the run.
- A failed check with a copy warns once and uses the copy.
  With no copy, it is `CLI_SPEC_UNAVAILABLE`.
- The file is written to a temporary name and renamed, so two processes never leave half a file.
- The spec request carries no credential.

The MCP server checks by ETag every 5 minutes, whatever the age of its copy.

## `x-lazco`

`src/core/generate/annotation.ts` checks each operation's `x-lazco` with a JSON Schema.

| Key | Values | Effect |
|---|---|---|
| `expose` | `false` | No command and no tool. Nothing else is read, but a hidden spend's `quote` still marks its quote operation, which then never registers as a tool alone |
| `cli` | words of `[a-z0-9][a-z0-9-]*` | The command, such as `compute delete` |
| `mcp` | `{ "name": "<snake_case>" }` or `false` | The tool name, or no tool |
| `kind` | `read`, `write`, `destructive`, `spend` | The confirmation, the MCP tier and the annotations |
| `feature` | a `whoami.features` key | Hidden when the feature is off |
| `async` | `task` | The answer is 202 `{ taskId }`, and the CLI waits for the task |
| `concurrency` | `etag` | Adds the input `ifMatch`, sent as `If-Match` |
| `confirm` | a body property | The field that must hold the resource's own name |
| `paginate` | `cursor`, `page` | A list over pages |
| `upload` | an uploader name | The uploader of that name runs the operation, see "Uploaders". A name this version lacks skips it |
| `quote` | an `operationId` | The quote operation of a `spend` operation, see "Spend operations". Ignored on any other kind |

A key the schema does not list is ignored, so a later key never breaks this version.
A known key with an unknown value skips the operation with one warning, because a guess could skip a confirmation or a precondition.

An operation is also skipped, with one warning each, when:

- it has no `x-lazco`, or an invalid one
- its first command word is `auth`, `profile` or `mcp`, which `lazco` owns
- `concurrency: etag` has no GET at the same path
- `upload` names an uploader this version lacks
- two operations share a command or a tool name, or a command is also a group of other commands
- a `$ref` cannot be resolved, the body is not `application/json`, or a header or cookie parameter other than `Idempotency-Key` is required
- a `spend` operation has no `quote`, its quote operation is not in the spec or is not `write`, it does not require `Idempotency-Key`, or its body does not require `quoteId` and `expectedAmount` as top-level body properties

## The input object

Each operation has one input object, the same for its command and its tool.

- Path parameters, query parameters and the top-level body properties are merged into it.
- A name clash with a parameter, or a body that is not an object, puts the whole body under `body`.
- `concurrency: etag` adds `ifMatch`.
  A bare version such as `7` is sent as the entity tag `"7"`.
  A weak tag, or a value that is no entity tag, is `CLI_INVALID_INPUT`, because `If-Match` compares strongly.
  Without `ifMatch`, the CLI reads the ETag with `Accept-Encoding: identity`, because a proxy that compresses the answer makes the tag weak, and `If-Match` never matches a weak tag.
  A weak ETag from that read is `CLI_BAD_RESPONSE`, and nothing is written.
- Local `$ref`s are resolved into the schema.
  A cyclic one stays in `$defs`.
- A key that is no input is refused, unless the body schema sets `additionalProperties`.

On the command line, path parameters are positional, scalars are kebab-case flags (`--region-slug`), an array of scalars repeats its flag, and anything nested goes through `--json`.
A property given by a flag and by `--json` is an error.
A command's input whose name is a global flag, or the operation flag `--idempotency-key`, is reachable through `--json` only.

## Spend operations

A `spend` operation takes money from the account balance, and its body requires `quoteId` and `expectedAmount`.
Its `quote` names the quote operation, a `write` operation that prices the same input and charges nothing.
The API mounts it at `<spend path>/quote`, and the CLI finds it by its `operationId` only.

- The command's input, `--json` and `--describe` hold neither `quoteId` nor `expectedAmount`.
  `--describe` names the quote operation in `quote`.
- A run sends the quote operation first, with the path parameters and the body fields the quote operation takes, or the whole input when its body is open, and a key of its own when it declares one.
- It writes the quote to stderr, then asks or needs `--yes`, and sends the spend with `quoteId` and the quote's `amount` unchanged as `expectedAmount`.
- Without a yes it exits 1 with `CLI_CONFIRM_REQUIRED`, and the error's `details.quote` holds the quote, or the `quoteId` and `amount` of `--quote-id` and `--expected-amount`.
- `--dry-run` sends the quote request only, and prints the spend request with the quote in `body` and the member `quote`.
- `--quote-id ID` with `--expected-amount AMOUNT` sends a quote the caller has, with no quote request.
  One without the other, or an amount that is not a decimal of at most 3 decimals, is `CLI_INVALID_INPUT` before any request.
  With `--dry-run` they send nothing, and `quote` is `null`.
- A `QUOTE_*` answer exits 1.
  The CLI never gets a new quote and resends, and the client never retries a `409` other than `IDEMPOTENCY_KEY_IN_PROGRESS`.
- When a spend run ends with no final answer, the key notice also names `--quote-id` and `--expected-amount`, because a run again with a new quote would send another body under the same key.
- Every money value stays the decimal string the API sent.
  Readable text shows TWD with the decimals the value carries, such as `NT$52.5`.

A quote answer holds `quoteId`, `operationId` (the spend operation it prices), `amount` and the other figures of the API's `Quote` schema.
The CLI needs `quoteId` and an `amount` of at most 3 decimals, and fails with `CLI_BAD_RESPONSE` before the question without them.

An MCP spend tool takes `quoteId` and `expectedAmount` as required inputs, and its quote tool takes the rest.
Both register only with `--allow-writes --allow-spend`, and a quote tool never registers without its spend tool.
With elicitation, a spend tool reads the quote back and asks only when its `operationId` is the tool's operation, its `status` is `open`, and its `amount` is the same decimal value as `expectedAmount`, so `402.5` matches `402.500`.
Any other quote is `CLI_INVALID_INPUT`, and a quote answer without a `quoteId` or with an `amount` of more than 3 decimals is `CLI_BAD_RESPONSE`, both with no question and no spend.
The question waits until the quote expires, for 60 seconds at least and 10 minutes at most.

## Idempotency-Key

An operation that declares the header parameter `Idempotency-Key`, required or optional, gets it from the core, never from its input.
Every `spend` operation declares it as required.

- The core makes one random UUID v4 for each command run or tool call, and sends it on every retry of that run or call.
- An operation with a required header takes the operation flag `--idempotency-key KEY` instead, so a script that runs a command again after a crash gets the first result.
  A key outside 1 to 255 printable ASCII characters is `CLI_INVALID_INPUT` before any request.
- The header is no field of `--describe`'s input schema or of a tool's `inputSchema`.
  `--describe` names it in `idempotencyKey`, as `required`, `optional` or `null`.
- `--dry-run` prints the header with the key it would send.
- When a run of an operation with a required header and a generated key ends with no final answer (`CLI_NETWORK`, `CLI_TIMEOUT`, `CLI_BAD_RESPONSE`, `IDEMPOTENCY_KEY_IN_PROGRESS` or a 429), stderr names the key, so the user can run the command again with `--idempotency-key` and get the first result.
- An answer with `Idempotent-Replayed: true` writes a note with the key to stderr, and stdout is the same JSON as the first answer.
- A key on stderr can reach a CI log.
  For 24 hours the key opens the stored answer for anyone who also holds a token of the organization, and an answer such as a rebuild's holds a password once.
  Keep such logs as private as the token.
- An uploader sends the operation's headers on its own start request.
  Its other requests, such as the Pages renewal and finalize, go to routes that declare no key, so the client sends each of them once and the uploader alone decides any retry.

## Uploaders

An uploader is hand-written behavior on a generated command, for an operation that is more than one request.
`KNOWN_UPLOADERS` in `src/core/generate/annotation.ts` names each one and the input it takes, and `UPLOADERS` in `src/uploads/registry.ts` holds its code.
The command path, the tool name, `kind` and `feature` still come from `x-lazco`.

- The uploader's input replaces the body in the input object, so `--describe`, `--json` and the tool's `inputSchema` show it and never the body.
- Its positionals follow the path parameters on the command line.
- The tool's description gains the uploader's notes.
- `--dry-run` runs the uploader's reads and checks, and sends no write.
- An MCP tool takes an absolute local path only, because the working directory of a stdio server is the client's choice.

`pages-deployment` (`src/uploads/pagesDeployment.ts` and `src/uploads/pages/`) publishes a local directory to a Pages site:

1. It refuses a missing path, a file, a zip archive, the home directory and a filesystem root before any request.
2. It reads `GET .../pages/deploy-rules` and the site. The limits and the extension lists come only from that answer, and the site must be `active`.
3. It walks the directory, skips every segment that starts with `.` or is `__MACOSX` or `node_modules`, refuses a link or a special file, and checks the four limits from the sizes alone.
4. It hashes every file with SHA-256 and sends the bytes of each file whose extension is in `contentExtensions` in `contentBase64`.
5. It PUTs every upload the start lists, with exactly its headers, 8 at a time, every file whose extension is not in `lastExtensions` first. Each file is hashed again right before its PUT. A network error, a timeout or a 5xx is tried 3 more times.
6. The upload window ends at `uploadExpiresAt`, read against the answer's `Date` header. With less than 10 minutes left, it renews the URLs of the uploads not started through `POST .../uploads`, and a 403 gets one renewal and one more PUT.
7. It finalizes, and reads the deployment every 5 seconds until it is `live` or `superseded`. `failed`, `abandoned` and `cancelled` are `CLI_TASK_FAILED`, and `--timeout` is `CLI_TIMEOUT`.

An error or an interrupt before finalize cancels the deployment once, and the first error stays the error.
An interrupt before the start is `CLI_TASK_FAILED` with nothing changed, during the upload `CLI_TASK_FAILED` with the deployment cancelled, and during the wait `CLI_TIMEOUT` with the deployment going on.
Each of these errors carries `details.interrupted`.
A second Ctrl-C ends the process at once.

## Pagination

| `paginate` | Answer | Next page |
|---|---|---|
| `cursor` | `{ "data": [...], "nextCursor": <string or null> }` | `--cursor <nextCursor>` |
| `page` | `{ "data": [...], "pagination": { "page", "totalPages", ... } }` | `--page <page + 1>` |

Without `--page-all`, the next flag goes to stderr as one `lazco: more results` line.

## Tasks

An `async: task` operation answers 202 `{ "taskId" }`.
The CLI reads `GET /v1/tasks/<taskId>` 2 seconds later, then 1.5 times later each time, up to 10 seconds apart, for 600 seconds by default (`--timeout`).
It prints `{ "accepted", "task" }`, because a value such as a rebuild's password is in the 202 body only.
`failed` is `CLI_TASK_FAILED`, and the timeout is `CLI_TIMEOUT` with the `taskId`.
Every error of the wait, a failed task read included, carries the 202 body as `accepted`, so the password is never lost.
`--no-wait` prints the 202 body at once, and an MCP tool always does.

## Feature hiding

The `whoami` answer is cached for 10 minutes at `<cache dir>/lazco/whoami/<sha256 of the credential>.json`, which never holds the credential.
A command whose feature is off leaves `--help` and `--describe`, and still runs by name, so the user sees the API's own refusal.
An MCP tool whose feature is off is not registered, and the instructions name the feature.
