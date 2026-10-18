import type Ajv2020 from "ajv/dist/2020.js";
import packageJson from "../../package.json" with { type: "json" };
import { HANDWRITTEN_COMMANDS } from "../commands/registry";
import type { HandwrittenCommand, HandwrittenContext } from "../commands/types";
import {
  cacheRoot,
  configFilePath,
  currentPathEnvironment,
  type PathEnvironment,
} from "../config/paths";
import { CliError, toToolError } from "../core/errors";
import { describeSkip, generateSurface, type Operation } from "../core/generate/operations";
import { CommandTree, type Resolution } from "../core/generate/tree";
import { createAjv } from "../core/request/ajv";
import { prepareRequest } from "../core/request/build";
import { ApiClient, type ApiRequest } from "../core/request/client";
import { type Clock, SYSTEM_CLOCK } from "../core/request/clock";
import { type ExecuteContext, executeOperation, type Task } from "../core/request/execute";
import type { InputProblem } from "../core/request/guard";
import { nextPageFlag, readPage, walkPages } from "../core/request/paginate";
import { RateLimiter } from "../core/request/rateLimiter";
import { InputValidator } from "../core/request/validate";
import { SpecSource } from "../core/spec/loader";
import { type Keychain, osKeychain } from "../credentials/keychain";
import { resolveSession, type Session, sessionCredential } from "../credentials/session";
import { confirmCommand } from "./confirm";
import { describeEntry, summarizeEntry } from "./describe";
import { type CommandEntry, handwrittenEntry, operationEntry } from "./entries";
import { isHidden, readFeatures } from "./features";
import { extractGlobalFlags, type GlobalFlags } from "./globalFlags";
import { commandUsage, groupUsage } from "./help";
import { buildInput, flagSpecs, parsePayload } from "./input";
import { type Io, readAll } from "./io";
import { writeError, writeNotice, writeResult } from "./output";

export const VERSION: string = packageJson.version;

export type RunOptions = {
  handwritten?: readonly HandwrittenCommand[];
  fetch?: typeof fetch;
  clock?: Clock;
  paths?: PathEnvironment;
  keychain?: Keychain;
};

/** Runs `lazco` with its arguments and returns the exit code: 0, or 1 on any error. */
export async function runCli(
  argv: readonly string[],
  io: Io,
  options: RunOptions = {},
): Promise<number> {
  let human = false;
  const secrets: string[] = [];
  try {
    const { flags, rest } = extractGlobalFlags(argv);
    human = flags.human;
    if (flags.version) {
      io.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (io.env.LAZCO_TOKEN) {
      secrets.push(io.env.LAZCO_TOKEN);
    }
    const shell = new Shell(io, flags, secrets, options);
    await shell.dispatch(rest);
    return 0;
  } catch (error) {
    writeError(io, toToolError(error).toBody(), { human, secrets });
    return 1;
  }
}

type Surface = { tree: CommandTree<CommandEntry> };

class Shell {
  private readonly io: Io;
  private readonly flags: GlobalFlags;
  private readonly activeSecrets: string[];
  private readonly clock: Clock;
  private readonly fetchImplementation: typeof fetch | undefined;
  private readonly limiter: RateLimiter;
  private readonly keychain: Keychain;
  private readonly configPath: string;
  private readonly cacheDirectory: string;
  private sessionPromise: Promise<Session> | undefined;
  private credentialPromise: Promise<string> | undefined;
  private specSourcePromise: Promise<SpecSource> | undefined;
  private readonly ajv: Ajv2020;
  private readonly validator: InputValidator;
  private readonly handwritten: readonly CommandEntry[];
  private readonly warnedSkips = new Set<string>();

  constructor(io: Io, flags: GlobalFlags, secrets: string[], options: RunOptions) {
    this.io = io;
    this.flags = flags;
    this.activeSecrets = secrets;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.fetchImplementation = options.fetch;
    this.limiter = new RateLimiter(this.clock);
    this.keychain = options.keychain ?? osKeychain();
    const paths = options.paths ?? currentPathEnvironment();
    this.cacheDirectory = cacheRoot(paths);
    this.configPath = configFilePath(paths);
    this.ajv = createAjv();
    this.validator = new InputValidator(this.ajv);
    this.handwritten = (options.handwritten ?? HANDWRITTEN_COMMANDS).map(handwrittenEntry);
  }

  private client(apiUrl: string, credential: string | undefined): ApiClient {
    return new ApiClient({
      apiUrl,
      credential,
      userAgent: `lazco-cli/${VERSION}`,
      limiter: this.limiter,
      fetch: this.fetchImplementation,
      clock: this.clock,
    });
  }

  private session(): Promise<Session> {
    this.sessionPromise ??= resolveSession({
      env: this.io.env,
      profileFlag: this.flags.profile,
      apiUrlFlag: this.flags.apiUrl,
      configPath: this.configPath,
    });
    return this.sessionPromise;
  }

  /** The session's credential, read once. Throws when there is none to send. */
  private credential(): Promise<string> {
    this.credentialPromise ??= this.session().then(async (session) => {
      const credential = await sessionCredential(session, this.io.env, this.keychain);
      this.addSecret(credential);
      return credential;
    });
    return this.credentialPromise;
  }

  private addSecret(value: string): void {
    if (value && !this.activeSecrets.includes(value)) {
      this.activeSecrets.push(value);
    }
  }

  private specSource(): Promise<SpecSource> {
    this.specSourcePromise ??= this.session().then(
      (session) =>
        new SpecSource({
          client: this.client(session.apiUrl, undefined),
          cacheDirectory: this.cacheDirectory,
          clock: this.clock,
          warn: (message) => writeNotice(this.io, `warning: ${message}`),
        }),
    );
    return this.specSourcePromise;
  }

  private handwrittenContext(): HandwrittenContext {
    return {
      io: this.io,
      flags: this.flags,
      configPath: this.configPath,
      keychain: this.keychain,
      session: () => this.session(),
      credential: () => this.credential(),
      client: (apiUrl, credential) => this.client(apiUrl, credential),
      addSecret: (value) => this.addSecret(value),
    };
  }

  async dispatch(rest: readonly string[]): Promise<void> {
    const firstFlag = rest.findIndex((token) => token.startsWith("-"));
    const words = firstFlag === -1 ? [...rest] : rest.slice(0, firstFlag);
    const tokensAfterWords = rest.slice(words.length);

    if (words.length === 0) {
      if (tokensAfterWords.length > 0) {
        throw unknownCommand(tokensAfterWords);
      }
      if (this.flags.describe) {
        await this.describeAll([]);
      } else {
        await this.rootHelp();
      }
      return;
    }

    const handwritten = new CommandTree(this.handwritten).resolve(words);
    if (handwritten.kind === "command") {
      await this.runEntry(handwritten.entry, [
        ...words.slice(handwritten.consumed),
        ...tokensAfterWords,
      ]);
      return;
    }

    let surface = await this.surface();
    let resolution = surface.tree.resolve(words);
    if (needsRefresh(resolution, words)) {
      const refreshed = await (await this.specSource()).refresh();
      if (refreshed) {
        surface = this.buildSurface(refreshed.document);
        resolution = surface.tree.resolve(words);
      }
    }
    if (resolution.kind === "unknown") {
      throw unknownCommand(words);
    }
    if (resolution.kind === "group") {
      if (this.flags.describe) {
        await this.describeAll(resolution.group, surface);
      } else if (this.flags.help) {
        await this.groupHelp(resolution.group, surface);
      } else {
        throw new CliError(
          "CLI_INVALID_INPUT",
          `"${resolution.group.join(" ")}" needs a command: ${resolution.children.join(", ")}`,
          [{ field: "command", message: `one of ${resolution.children.join(", ")}` }],
        );
      }
      return;
    }
    await this.runEntry(resolution.entry, [
      ...words.slice(resolution.consumed),
      ...tokensAfterWords,
    ]);
  }

  private async surface(): Promise<Surface> {
    return this.buildSurface((await (await this.specSource()).get()).document);
  }

  private buildSurface(document: Parameters<typeof generateSurface>[0]): Surface {
    const generated = generateSurface(document, this.ajv);
    for (const skip of generated.skipped) {
      const message = describeSkip(skip);
      if (!this.warnedSkips.has(message)) {
        this.warnedSkips.add(message);
        writeNotice(this.io, `warning: ${message}`);
      }
    }
    return {
      tree: new CommandTree([...generated.operations.map(operationEntry), ...this.handwritten]),
    };
  }

  /** The commands `--help` and `--describe` list: every one whose feature is not off. */
  private async visibleEntries(
    prefix: readonly string[],
    surface?: Surface,
  ): Promise<CommandEntry[]> {
    const entries = surface
      ? surface.tree.below(prefix)
      : this.handwritten.filter((entry) => startsWith(entry.command, prefix));
    const features = await this.features();
    return entries
      .filter((entry) => !isHidden(entry.feature, features))
      .sort((left, right) => left.command.join(" ").localeCompare(right.command.join(" ")));
  }

  /**
   * The organization's features, or `undefined` when there is no credential
   * to ask with, which hides nothing. A stored credential that `--api-url`
   * points elsewhere is not sent for this.
   */
  private async features(): Promise<Record<string, boolean> | undefined> {
    const session = await this.session();
    if (session.source.kind === "none" || session.conflictingProfileUrl !== undefined) {
      return undefined;
    }
    let credential: string;
    try {
      credential = await this.credential();
    } catch (error) {
      writeNotice(
        this.io,
        `warning: no command is hidden, because the credential could not be read: ${toToolError(error).message}`,
      );
      return undefined;
    }
    return readFeatures({
      client: this.client(session.apiUrl, credential),
      credential,
      cacheDirectory: this.cacheDirectory,
      clock: this.clock,
      warn: (message) => writeNotice(this.io, `warning: ${message}`),
    });
  }

  private async describeAll(prefix: readonly string[], surface?: Surface): Promise<void> {
    const entries = await this.visibleEntries(prefix, surface ?? (await this.surface()));
    writeResult(
      this.io,
      { list: entries.map(summarizeEntry) },
      { human: this.flags.human, fields: this.flags.fields, secrets: this.secrets() },
    );
  }

  private async rootHelp(): Promise<void> {
    let surface: Surface | undefined;
    try {
      surface = await this.surface();
    } catch (error) {
      writeNotice(
        this.io,
        `warning: ${toToolError(error).message}, so only the built-in commands are listed`,
      );
    }
    await this.groupHelp([], surface);
  }

  private async groupHelp(prefix: readonly string[], surface?: Surface): Promise<void> {
    const entries = await this.visibleEntries(prefix, surface);
    const children = new Map<string, string>();
    for (const entry of entries) {
      const word = entry.command[prefix.length];
      if (word === undefined) continue;
      const isLeaf = entry.command.length === prefix.length + 1;
      if (isLeaf || !children.has(word)) {
        children.set(word, isLeaf ? entry.summary : `${[...prefix, word].join(" ")} commands`);
      }
    }
    const sorted = [...children.entries()].sort(([left], [right]) => left.localeCompare(right));
    this.io.stdout.write(
      await groupUsage(
        prefix,
        sorted.map(([word, summary]) => ({ word, summary })),
      ),
    );
  }

  private secrets(): string[] {
    return this.activeSecrets;
  }

  private async runEntry(entry: CommandEntry, tokens: readonly string[]): Promise<void> {
    if (this.flags.help) {
      this.io.stdout.write(await commandUsage(entry));
      return;
    }
    if (this.flags.describe) {
      writeResult(
        this.io,
        { record: describeEntry(entry) },
        { human: this.flags.human, fields: this.flags.fields, secrets: this.secrets() },
      );
      return;
    }
    const payloadText = this.flags.json === "-" ? await readAll(this.io.stdin) : this.flags.json;
    const payload = payloadText === undefined ? undefined : parsePayload(payloadText);
    const input = buildInput({
      schema: entry.inputSchema,
      positionals: entry.positionals,
      tokens,
      payload,
    });
    const output = { human: this.flags.human, fields: this.flags.fields, secrets: this.secrets() };
    if (entry.source.type === "handwritten") {
      this.validator.check(entry.inputSchema, input);
      writeResult(
        this.io,
        await entry.source.handwritten.run(input, this.handwrittenContext()),
        output,
      );
      return;
    }
    const session = await this.session();
    const operation = entry.source.operation;
    if (this.flags.pageAll && !operation.annotation.paginate) {
      throw new CliError(
        "CLI_INVALID_INPUT",
        `${entry.command.join(" ")} is not a paginated list`,
        [{ field: "page-all", message: "needs a paginated command" }],
      );
    }
    const prepare = (pageInput: Record<string, unknown>): ApiRequest =>
      prepareRequest(operation, pageInput, {
        apiUrl: session.apiUrl,
        validator: this.validator,
      });
    checkBeforeConfirm(operation, input, prepare);
    const credential = this.flags.dryRun ? undefined : await this.credential();
    const client = this.client(session.apiUrl, credential);
    const confirmed = this.flags.dryRun
      ? input
      : await confirmCommand(
          { command: entry.command, kind: entry.kind, confirmField: operation.annotation.confirm },
          input,
          {
            io: this.io,
            yes: this.flags.yes,
            flagOf: (property) => flagOf(entry, property),
          },
        );
    const request = prepare(confirmed);
    if (this.flags.dryRun) {
      writeResult(this.io, { record: dryRunPreview(client, operation, request) }, output);
      return;
    }
    const context: ExecuteContext = { client, clock: this.clock };
    if (operation.annotation.paginate) {
      if (this.flags.pageAll) {
        const items = await walkPages(
          operation,
          confirmed,
          prepare,
          context,
          (pageNumber, itemCount) =>
            writeNotice(this.io, `page ${pageNumber}, ${itemCount} items so far`),
        );
        writeResult(this.io, { list: items }, output);
        return;
      }
      const page = readPage(
        operation,
        await executeOperation(operation, request, context, { wait: false, timeoutSeconds: 0 }),
      );
      writeResult(this.io, { list: page.items }, output);
      if (page.next) {
        writeNotice(
          this.io,
          `more results: run again with ${nextPageFlag(page.next)}, or with --page-all`,
        );
      }
      return;
    }
    const body = await executeOperation(operation, request, context, {
      wait: this.flags.wait,
      timeoutSeconds: this.flags.timeoutSeconds,
      onTask: (task) => writeNotice(this.io, describeTask(task)),
    });
    writeResult(this.io, Array.isArray(body) ? { list: body } : { record: body }, output);
  }
}

function dryRunPreview(
  client: ApiClient,
  operation: Operation,
  request: ApiRequest,
): Record<string, unknown> {
  const preview: Record<string, unknown> = {
    dryRun: true,
    method: request.method,
    url: client.url(request),
    headers: client.publicHeaders(request),
    body: request.body ?? null,
  };
  if (operation.annotation.concurrency === "etag" && request.headers?.["If-Match"] === undefined) {
    preview.ifMatchFrom = { method: "GET", url: client.url({ path: request.path }) };
  }
  return preview;
}

function startsWith(command: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((word, index) => command[index] === word);
}

/** An unknown word, or a word past a group that the cached spec may not have yet. */
function needsRefresh(resolution: Resolution<CommandEntry>, words: readonly string[]): boolean {
  return (
    resolution.kind === "unknown" ||
    (resolution.kind === "group" && words.length > resolution.group.length)
  );
}

function unknownCommand(words: readonly string[]): CliError {
  return new CliError("CLI_INVALID_INPUT", `Unknown command: ${words.join(" ")}`, [
    { field: "command", message: "run lazco --describe to list every command" },
  ]);
}

function flagOf(entry: CommandEntry, property: string): string {
  const spec = flagSpecs(entry.inputSchema, entry.positionals).find(
    (candidate) => candidate.property === property,
  );
  return spec ? `--${spec.flag}` : `"${property}" of --json`;
}

function describeTask(task: Task): string {
  const progress = typeof task.progress === "number" ? ` ${task.progress}%` : "";
  const step = typeof task.step === "string" && task.step ? ` (${task.step})` : "";
  return `task ${task.id ?? ""} ${task.status ?? "unknown"}${progress}${step}`;
}

/**
 * Checks the input before a confirmation is asked, so a doomed command never
 * asks. The `confirm` field may still be missing, because the answer fills it.
 */
function checkBeforeConfirm(
  operation: Operation,
  input: Record<string, unknown>,
  prepare: (input: Record<string, unknown>) => ApiRequest,
): void {
  try {
    prepare(input);
  } catch (error) {
    const field = operation.annotation.confirm;
    const onlyConfirmMissing =
      error instanceof CliError &&
      error.code === "CLI_INVALID_INPUT" &&
      field !== undefined &&
      Array.isArray(error.details) &&
      (error.details as InputProblem[]).every((problem) => problem.field === field);
    if (!onlyConfirmMissing) {
      throw error;
    }
  }
}
