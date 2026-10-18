# The spec contract

The CLI reads the API's OpenAPI 3.1 spec at `GET /v1/spec`, and the `x-lazco` object of each operation decides the command, the tool and how a call behaves.
The backend owns the names, so a wrong command or tool name is fixed in the backend's `x-lazco`, never here.

## The cache

The spec of an API URL is cached at `<cache dir>/lazco/spec/<sha256 of the API URL>.json` with its ETag and the time it was checked.
The cache dir is `$XDG_CACHE_HOME`, `~/.cache` when unset, and `%LOCALAPPDATA%` on Windows.

- A copy younger than 10 minutes is used with no request.
- An older one is checked with `If-None-Match`, and a 304 keeps it.
- A command name the copy lacks refreshes it once in the run.
- A failed check with a copy warns once and uses the copy. With no copy, it is `CLI_SPEC_UNAVAILABLE`.
- The file is written to a temporary name and renamed, so two processes never leave half a file.
- The spec request carries no credential.

The MCP server checks by ETag every 5 minutes, whatever the age of its copy.

## `x-lazco`

`src/core/generate/annotation.ts` checks each operation's `x-lazco` with a JSON Schema.

| Key | Values | Effect |
|---|---|---|
| `expose` | `false` | No command and no tool. Nothing else is read |
| `cli` | words of `[a-z0-9][a-z0-9-]*` | The command, such as `compute delete` |
| `mcp` | `{ "name": "<snake_case>" }` or `false` | The tool name, or no tool |
| `kind` | `read`, `write`, `destructive`, `spend` | The confirmation, the MCP tier and the annotations |
| `feature` | a `whoami.features` key | Hidden when the feature is off |
| `async` | `task` | The answer is 202 `{ taskId }`, and the CLI waits for the task |
| `concurrency` | `etag` | Adds the input `ifMatch`, sent as `If-Match` |
| `confirm` | a body property | The field that must hold the resource's own name |
| `paginate` | `cursor`, `page` | A list over pages |
| `upload` | an uploader name | Needs an uploader this version has |

A key the schema does not list is ignored, so a later key such as `quote` never breaks this version.
A known key with an unknown value skips the operation with one warning, because a guess could skip a confirmation or a precondition.

An operation is also skipped, with one warning each, when:

- it has no `x-lazco`, or an invalid one
- its first command word is `auth`, `profile` or `mcp`, which `lazco` owns
- `concurrency: etag` has no GET at the same path
- `upload` names an uploader this version lacks
- two operations share a command or a tool name, or a command is also a group of other commands
- a `$ref` cannot be resolved, the body is not `application/json`, or a header or cookie parameter is required

## The input object

Each operation has one input object, the same for its command and its tool.

- Path parameters, query parameters and the top-level body properties are merged into it.
- A name clash with a parameter, or a body that is not an object, puts the whole body under `body`.
- `concurrency: etag` adds `ifMatch`.
- Local `$ref`s are resolved into the schema. A cyclic one stays in `$defs`.
- A key that is no input is refused, unless the body schema sets `additionalProperties`.

On the command line, path parameters are positional, scalars are kebab-case flags (`--region-slug`), an array of scalars repeats its flag, and anything nested goes through `--json`.
A property given by a flag and by `--json` is an error.
A command's input whose name is a global flag is reachable through `--json` only.

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
