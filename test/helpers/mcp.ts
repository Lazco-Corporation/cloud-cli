import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ElicitRequestSchema,
  type ElicitResult,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createAjv } from "../../src/core/request/ajv";
import { ApiClient } from "../../src/core/request/client";
import { type Clock, SYSTEM_CLOCK } from "../../src/core/request/clock";
import { RateLimiter } from "../../src/core/request/rateLimiter";
import { InputValidator } from "../../src/core/request/validate";
import { SpecSource } from "../../src/core/spec/loader";
import { staticCredential } from "../../src/credentials/credential";
import { McpSession, type Scheduler } from "../../src/mcp/server";
import { VERSION } from "../../src/shell/run";
import { FAKE_TOKEN } from "./cli";
import type { FakeApi } from "./fakeApi";

/** A scheduler a test runs by hand: each `tick` runs every task once and waits for it. */
export function manualScheduler(): Scheduler & {
  intervals: number[];
  stopped: number;
  tick(): Promise<void>;
} {
  const tasks: Array<() => Promise<unknown>> = [];
  const scheduler = {
    intervals: [] as number[],
    stopped: 0,
    every(intervalMs: number, task: () => Promise<unknown>) {
      scheduler.intervals.push(intervalMs);
      tasks.push(task);
      return () => {
        scheduler.stopped += 1;
        tasks.splice(tasks.indexOf(task), 1);
      };
    },
    async tick() {
      for (const task of [...tasks]) {
        await task();
      }
    },
  };
  return scheduler;
}

export type ConnectedSession = {
  session: McpSession;
  client: Client;
  scheduler: ReturnType<typeof manualScheduler>;
  warnings: string[];
  listChanged: number;
  /** The message of every `elicitation/create` the client got. */
  elicitations: string[];
  close(): Promise<void>;
};

/** How the test client answers `elicitation/create`, which it declares only when given. */
export type ElicitationAnswer = (message: string) => ElicitResult | Promise<ElicitResult>;

/** Starts a session against a fake API and connects an SDK client to it in memory. */
export async function connectSession(
  api: Pick<FakeApi, "apiUrl">,
  options: {
    allowWrites?: boolean;
    allowSpend?: boolean;
    /** The `--only` prefixes, each as its words. */
    only?: ReadonlyArray<readonly string[]>;
    cacheDirectory: string;
    clock?: Clock;
    elicitation?: ElicitationAnswer;
    /** The `elicitation` capability the client declares with an answer, `{}` (form) unless given. */
    elicitationCapability?: Record<string, unknown>;
  },
): Promise<ConnectedSession> {
  const limiter = new RateLimiter(SYSTEM_CLOCK);
  const ajv = createAjv();
  const warnings: string[] = [];
  const scheduler = manualScheduler();
  const session = await McpSession.start({
    version: VERSION,
    allowWrites: options.allowWrites === true,
    allowSpend: options.allowSpend === true,
    only: options.only ?? [],
    secrets: () => [FAKE_TOKEN],
    client: new ApiClient({
      apiUrl: api.apiUrl,
      credential: staticCredential(FAKE_TOKEN),
      userAgent: "lazco-test",
      limiter,
    }),
    specSource: new SpecSource({
      client: new ApiClient({ apiUrl: api.apiUrl, userAgent: "lazco-test", limiter }),
      cacheDirectory: options.cacheDirectory,
      warn: (message) => warnings.push(message),
    }),
    ajv,
    validator: new InputValidator(ajv),
    warn: (message) => warnings.push(message),
    scheduler,
    clock: options.clock,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.connect(serverTransport);
  const elicitation = options.elicitation;
  const client = new Client(
    { name: "test-client", version: "1.2.3" },
    elicitation === undefined
      ? {}
      : { capabilities: { elicitation: options.elicitationCapability ?? {} } },
  );
  const connected: ConnectedSession = {
    session,
    client,
    scheduler,
    warnings,
    listChanged: 0,
    elicitations: [],
    close: async () => {
      await client.close();
    },
  };
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    connected.listChanged += 1;
  });
  if (elicitation !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      connected.elicitations.push(request.params.message);
      return elicitation(request.params.message);
    });
  }
  await client.connect(clientTransport);
  return connected;
}

/** The JSON of a tool result's one text item. */
export function resultJson(result: Record<string, unknown>): unknown {
  const content = result.content as Array<{ type: string; text: string }>;
  if (content.length !== 1 || content[0]?.type !== "text") {
    throw new Error(`expected one text item, got ${JSON.stringify(content)}`);
  }
  return JSON.parse(content[0].text);
}
