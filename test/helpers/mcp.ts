import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createAjv } from "../../src/core/request/ajv";
import { ApiClient } from "../../src/core/request/client";
import { SYSTEM_CLOCK } from "../../src/core/request/clock";
import { RateLimiter } from "../../src/core/request/rateLimiter";
import { InputValidator } from "../../src/core/request/validate";
import { SpecSource } from "../../src/core/spec/loader";
import { McpSession, type Scheduler } from "../../src/mcp/server";
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
  close(): Promise<void>;
};

/** Starts a session against a fake API and connects an SDK client to it in memory. */
export async function connectSession(
  api: FakeApi,
  options: { allowWrites?: boolean; cacheDirectory: string },
): Promise<ConnectedSession> {
  const limiter = new RateLimiter(SYSTEM_CLOCK);
  const ajv = createAjv();
  const warnings: string[] = [];
  const scheduler = manualScheduler();
  const session = await McpSession.start({
    version: "0.0.0",
    allowWrites: options.allowWrites === true,
    credential: FAKE_TOKEN,
    client: new ApiClient({
      apiUrl: api.apiUrl,
      credential: FAKE_TOKEN,
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
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await session.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.2.3" });
  const connected: ConnectedSession = {
    session,
    client,
    scheduler,
    warnings,
    listChanged: 0,
    close: async () => {
      await client.close();
    },
  };
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    connected.listChanged += 1;
  });
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
