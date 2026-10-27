import { homedir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type Ajv2020 from "ajv/dist/2020.js";
import { CliError, redactSecrets, toToolError } from "../core/errors";
import {
  describeSkip,
  EXPECTED_AMOUNT_INPUT,
  generateSurface,
  type Operation,
  QUOTE_ID_INPUT,
} from "../core/generate/operations";
import { describeQuote, formatTwd, type Quote, readQuote, sameAmount } from "../core/quote";
import { prepareRequest } from "../core/request/build";
import { type ApiClient, requireJson } from "../core/request/client";
import { type Clock, SYSTEM_CLOCK } from "../core/request/clock";
import { DEFAULT_WAIT_SECONDS, executeOperation } from "../core/request/execute";
import { guardPathParameters } from "../core/request/guard";
import { newIdempotencyKey } from "../core/request/idempotency";
import { readPage } from "../core/request/paginate";
import type { InputValidator } from "../core/request/validate";
import type { SpecSource } from "../core/spec/loader";
import type { OpenApiDocument } from "../core/spec/types";
import { UPLOADERS } from "../uploads/registry";
import {
  type CommandPrefix,
  listedTools,
  prefixText,
  type SessionFacts,
  selectTools,
  sessionInstructions,
  type ToolSet,
  taskToolName,
  toolSetSignature,
  unmatchedPrefixes,
} from "./tools";

/** How long a quote holds after the API priced it. */
const QUOTE_LIFETIME_MS = 10 * 60 * 1000;
/** The shortest time the user gets to answer a spend question. */
const MIN_ANSWER_WINDOW_MS = 60 * 1000;

/**
 * How long the user has to answer a spend question: until the quote
 * expires, never past its 10 minutes, and never under the SDK's 60 seconds,
 * so a local clock that runs ahead does not cut the question short.
 */
export function answerWindowMs(expiresAt: unknown, now: number): number {
  const left = (typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN) - now;
  return Number.isFinite(left)
    ? Math.min(Math.max(left, MIN_ANSWER_WINDOW_MS), QUOTE_LIFETIME_MS)
    : QUOTE_LIFETIME_MS;
}

/** How often a connected server checks the spec and `whoami` again. */
export const RECHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Runs a task on an interval, and returns what stops it. Tests drive it by hand. */
export type Scheduler = { every(intervalMs: number, task: () => Promise<unknown>): () => void };

/** An interval that never keeps the process alive on its own. */
export const SYSTEM_SCHEDULER: Scheduler = {
  every(intervalMs, task) {
    const timer = setInterval(() => void task(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  },
};

export type McpSessionOptions = {
  version: string;
  allowWrites: boolean;
  /** Offer the spend tools and their quote tools, with `allowWrites` too. */
  allowSpend: boolean;
  /** The `--only` prefixes, empty for every tool. */
  only: readonly CommandPrefix[];
  /** Every secret of the credential so far, which no tool result may show. */
  secrets: () => readonly string[];
  /** The API client with the credential, which every tool call and `whoami` use. */
  client: ApiClient;
  /** The spec of the client's API URL. */
  specSource: SpecSource;
  ajv: Ajv2020;
  validator: InputValidator;
  warn: (message: string) => void;
  clock?: Clock;
  scheduler?: Scheduler;
  /** Called with the client's name and version once `initialize` names them. */
  onClient?: (client: { name: string; version: string }) => void;
  /** The `fetch` an uploader PUTs files with, which never carries the credential. */
  storageFetch?: typeof fetch;
  homeDirectory?: string;
};

/** What a tool call may carry besides its arguments. */
export type ToolCallExtra = {
  /** Aborts when the client cancels the call. */
  signal?: AbortSignal;
  /** Sends one progress notification, when the call carried a progress token. */
  progress?: (message: string) => void;
};

/** The organization, the scope and the features of a `whoami` answer. */
export function readFacts(whoami: unknown): SessionFacts {
  const value = whoami as {
    organization?: { id?: unknown; name?: unknown };
    principal?: { scope?: unknown };
    features?: unknown;
  } | null;
  const organization = value?.organization;
  const scope = value?.principal?.scope;
  if (
    typeof organization?.id !== "string" ||
    typeof organization.name !== "string" ||
    typeof scope !== "string"
  ) {
    throw new CliError(
      "CLI_BAD_RESPONSE",
      "GET /whoami answered without the organization or the scope",
    );
  }
  const features =
    value?.features !== null && typeof value?.features === "object"
      ? Object.fromEntries(
          Object.entries(value.features as Record<string, unknown>).filter(
            ([, enabled]) => typeof enabled === "boolean",
          ),
        )
      : {};
  return {
    organization: { id: organization.id, name: organization.name },
    scope,
    features: features as Record<string, boolean>,
  };
}

/**
 * The tools of a spec for the session, with one warning for each skipped
 * operation, and the `--only` prefixes that match no operation of the spec.
 */
function buildToolSet(
  document: OpenApiDocument,
  facts: SessionFacts,
  options: Pick<McpSessionOptions, "ajv" | "allowWrites" | "allowSpend" | "only" | "warn">,
  warnedSkips: Set<string>,
): { toolSet: ToolSet; unmatched: CommandPrefix[] } {
  const generated = generateSurface(document, options.ajv);
  for (const skip of generated.skipped) {
    const message = describeSkip(skip);
    if (!warnedSkips.has(message)) {
      warnedSkips.add(message);
      options.warn(`warning: ${message}`);
    }
  }
  return {
    toolSet: selectTools(generated.operations, {
      allowWrites: options.allowWrites,
      allowSpend: options.allowSpend,
      facts,
      only: options.only,
    }),
    unmatched: unmatchedPrefixes(generated.operations, options.only),
  };
}

/**
 * One MCP session of `lazco mcp`: the tools of the spec by tier, the calls
 * through the core, and the 5-minute check that keeps the list current.
 */
export class McpSession {
  readonly server: Server;
  /** Settles when the transport closes, such as when the client ends stdin. */
  readonly closed: Promise<void>;
  private readonly options: McpSessionOptions;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly warnedSkips: Set<string>;
  /** The `--only` prefixes that matched no operation at the last check. */
  private unmatched = new Set<string>();
  private toolSet: ToolSet;
  private stopChecks: (() => void) | undefined;
  private checking = false;

  private constructor(
    options: McpSessionOptions,
    toolSet: ToolSet,
    facts: SessionFacts,
    warnedSkips: Set<string>,
  ) {
    this.options = options;
    this.warnedSkips = warnedSkips;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.scheduler = options.scheduler ?? SYSTEM_SCHEDULER;
    this.toolSet = toolSet;
    this.server = new Server(
      { name: "lazco", title: "Lazco Cloud", version: options.version },
      {
        capabilities: { tools: { listChanged: true } },
        instructions: sessionInstructions(toolSet, facts),
      },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: listedTools(this.toolSet) as never,
    }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const progressToken = request.params._meta?.progressToken;
      let progress = 0;
      return this.callTool(request.params.name, request.params.arguments ?? {}, {
        signal: extra.signal,
        progress:
          progressToken === undefined
            ? undefined
            : (message) => {
                progress += 1;
                void extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress,
                      message: redactSecrets(message, this.options.secrets()),
                    },
                  })
                  .catch(() => {});
              },
      });
    });
    this.server.oninitialized = () => {
      const client = this.server.getClientVersion();
      if (client) {
        options.onClient?.({ name: client.name, version: client.version });
      }
      this.stopChecks ??= this.scheduler.every(RECHECK_INTERVAL_MS, () => this.recheck());
    };
    this.closed = new Promise((resolve) => {
      this.server.onclose = () => {
        this.stopChecks?.();
        this.stopChecks = undefined;
        resolve();
      };
    });
  }

  /**
   * Reads `whoami` and the spec, which the instructions of `initialize`
   * need, so no MCP message is read before both answer.
   */
  static async start(options: McpSessionOptions): Promise<McpSession> {
    const facts = readFacts(
      requireJson(await options.client.call({ method: "GET", path: "/whoami" })),
    );
    const spec = await options.specSource.get();
    const warnedSkips = new Set<string>();
    const { toolSet, unmatched } = buildToolSet(spec.document, facts, options, warnedSkips);
    if (unmatched.length > 0) {
      const named = unmatched.map((prefix) => `"${prefixText(prefix)}"`).join(", ");
      throw new CliError(
        "CLI_INVALID_INPUT",
        `--only ${named} matches no command with an MCP tool. Check a prefix with lazco <prefix> --help`,
        unmatched.map((prefix) => ({
          field: "only",
          message: `"${prefixText(prefix)}" matches no command with an MCP tool`,
        })),
      );
    }
    return new McpSession(options, toolSet, facts, warnedSkips);
  }

  get tools(): ToolSet {
    return this.toolSet;
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    await this.server.close();
  }

  /**
   * Checks the spec by ETag and reads `whoami` again, and sends
   * `notifications/tools/list_changed` only when the listed tools changed.
   * A failed check keeps the tools as they are.
   */
  async recheck(): Promise<boolean> {
    if (this.checking) {
      return false;
    }
    this.checking = true;
    try {
      const spec = await this.options.specSource.revalidate();
      const facts = readFacts(
        requireJson(await this.options.client.call({ method: "GET", path: "/whoami" })),
      );
      const { toolSet: next, unmatched } = buildToolSet(
        spec.document,
        facts,
        this.options,
        this.warnedSkips,
      );
      this.warnDroppedPrefixes(unmatched);
      if (toolSetSignature(next) === toolSetSignature(this.toolSet)) {
        return false;
      }
      this.toolSet = next;
      await this.server.sendToolListChanged();
      return true;
    } catch (error) {
      this.options.warn(
        `warning: the tool list could not be checked, so it stays as it is: ${toToolError(error).message}`,
      );
      return false;
    } finally {
      this.checking = false;
    }
  }

  /**
   * Warns once when a prefix stops matching. The instructions of
   * `initialize` cannot change, so stderr is the only place to say it.
   */
  private warnDroppedPrefixes(unmatched: readonly CommandPrefix[]): void {
    const now = new Set(unmatched.map(prefixText));
    for (const prefix of now) {
      if (!this.unmatched.has(prefix)) {
        this.options.warn(
          `warning: --only "${prefix}" matches no command with an MCP tool any more, so it offers no tool`,
        );
      }
    }
    this.unmatched = now;
  }

  /** One tool call through the guard, the schema check and the request pipeline. */
  async callTool(
    name: string,
    input: Record<string, unknown>,
    extra: ToolCallExtra = {},
  ): Promise<CallToolResult> {
    try {
      const tool = this.toolSet.tools.find((candidate) => candidate.name === name);
      if (!tool) {
        throw new CliError("CLI_INVALID_INPUT", `No tool is named ${name} in this session`, [
          { field: "name", message: "names no tool of tools/list" },
        ]);
      }
      const operation = { ...tool.operation, inputSchema: tool.inputSchema };
      const request = prepareRequest(operation, input, {
        apiUrl: this.options.client.apiUrl,
        validator: this.options.validator,
        // A new key for each call, which the client keeps on every retry of it.
        idempotencyKey: operation.idempotencyKey === null ? undefined : newIdempotencyKey(),
      });
      if (operation.body.mode === "upload") {
        return this.text(await this.runUploader(operation, request, input, extra), false);
      }
      if (operation.kind === "spend" && this.server.getClientCapabilities()?.elicitation) {
        await this.confirmSpend(operation, input, extra);
      }
      const body = await executeOperation(
        operation,
        request,
        { client: this.options.client, clock: this.clock },
        { wait: false, timeoutSeconds: 0 },
      );
      let result: unknown = body;
      if (operation.annotation.paginate) {
        readPage(operation, body);
      } else if (
        operation.annotation.async === "task" &&
        typeof (body as { taskId?: unknown } | null)?.taskId === "string"
      ) {
        result = { accepted: body, taskTool: taskToolName(this.toolSet) ?? null };
      }
      return this.text(result, false);
    } catch (error) {
      return this.text({ error: toToolError(error).toBody() }, true);
    }
  }

  /**
   * Asks the user to confirm a spend through elicitation, with the quote as
   * the API holds it, never as the model passed it. Throws unless the user
   * accepted with `confirm` true.
   */
  private async confirmSpend(
    operation: Operation,
    input: Record<string, unknown>,
    extra: ToolCallExtra,
  ): Promise<void> {
    const { [QUOTE_ID_INPUT]: quoteId } = guardPathParameters([QUOTE_ID_INPUT], input);
    const response = await this.options.client.call({
      method: "GET",
      path: `/billing/quotes/${encodeURIComponent(quoteId as string)}`,
    });
    const quote: Quote = readQuote(requireJson(response), "GET /billing/quotes/{quoteId}");
    // The user is asked only about a quote this spend can use.
    if (quote.operationId !== operation.operationId) {
      const target =
        typeof quote.operationId === "string"
          ? `is for ${quote.operationId}`
          : "names no operation";
      throw new CliError(
        "CLI_INVALID_INPUT",
        `The quote ${quote.quoteId} ${target}, not this tool's. Get a quote from its quote tool`,
        [{ field: QUOTE_ID_INPUT, message: "must be a quote of this tool's quote tool" }],
      );
    }
    if (quote.status !== "open") {
      throw new CliError(
        "CLI_INVALID_INPUT",
        `The quote ${quote.quoteId} is ${typeof quote.status === "string" ? quote.status : "not open"}. Get a new quote and show it to the user`,
        [{ field: QUOTE_ID_INPUT, message: "must be an open quote" }],
      );
    }
    const expected = input[EXPECTED_AMOUNT_INPUT] as string;
    if (!sameAmount(expected, quote.amount)) {
      throw new CliError(
        "CLI_INVALID_INPUT",
        `${EXPECTED_AMOUNT_INPUT} ${expected} is not the quote's amount "${quote.amount}". Show the user the quote of "${quote.amount}" and pass that amount unchanged`,
        [{ field: EXPECTED_AMOUNT_INPUT, message: `must be the quote's amount "${quote.amount}"` }],
      );
    }
    const title = operation.summary || operation.toolName || operation.operationId;
    const message = [
      `${title}: spend ${formatTwd(quote.amount)} from the account balance?`,
      ...describeQuote(quote),
    ].join("\n");
    let answer: Awaited<ReturnType<Server["elicitInput"]>>;
    try {
      answer = await this.server.elicitInput(
        {
          mode: "form",
          message: redactSecrets(message, this.options.secrets()),
          requestedSchema: {
            type: "object",
            properties: {
              confirm: {
                type: "boolean",
                title: "Spend from the account balance",
                description: `Yes spends ${formatTwd(quote.amount)} from the account balance`,
              },
            },
            required: ["confirm"],
          },
        },
        // The user may read the quote for as long as it holds, not only the SDK's 60 seconds.
        { signal: extra.signal, timeout: answerWindowMs(quote.expiresAt, this.clock.now()) },
      );
    } catch (error) {
      throw new CliError(
        "CLI_CONFIRM_REQUIRED",
        `The user could not be asked to confirm the spend, so nothing was spent: ${toToolError(error).message}`,
        { quoteId: quote.quoteId },
      );
    }
    if (answer.action !== "accept" || answer.content?.confirm !== true) {
      throw new CliError(
        "CLI_CONFIRM_REQUIRED",
        "The user did not confirm the spend, so nothing was spent. Do not spend without a new yes",
        { quoteId: quote.quoteId, action: answer.action },
      );
    }
  }

  /** Runs an upload tool: an absolute local path only, and the wait for its result. */
  private async runUploader(
    operation: ToolSet["tools"][number]["operation"],
    request: ReturnType<typeof prepareRequest>,
    input: Record<string, unknown>,
    extra: ToolCallExtra,
  ): Promise<Record<string, unknown>> {
    const name = operation.body.mode === "upload" ? operation.body.uploader : "";
    const uploader = UPLOADERS.get(name);
    if (!uploader) {
      throw new CliError("CLI_INTERNAL", `This version has no code for the uploader ${name}`);
    }
    return uploader({
      operation,
      input,
      request,
      client: this.options.client,
      dryRun: false,
      timeoutSeconds: DEFAULT_WAIT_SECONDS,
      clock: this.clock,
      storageFetch: this.options.storageFetch ?? fetch,
      signal: extra.signal ?? new AbortController().signal,
      homeDirectory: this.options.homeDirectory ?? homedir(),
      workingDirectory: process.cwd(),
      requireAbsolutePaths: true,
      progress: extra.progress ?? (() => {}),
    });
  }

  private text(value: unknown, isError: boolean): CallToolResult {
    const safe = redactSecrets(value, this.options.secrets());
    return {
      content: [{ type: "text", text: JSON.stringify(safe ?? null) }],
      ...(isError ? { isError: true } : {}),
    };
  }
}
