/**
 * Runs the MCP evaluation set through `pi` and grades each task.
 *
 *   bun eval/mcp/run.ts --tier read [--profile staging] [--model <model>] [--concurrency 4] [--only id,id]
 *     [--pages-site <name>]
 *
 * Before a run, `lazco mcp install --client pi --profile <profile>` must have
 * written the `lazco` entry of `~/.pi/agent/mcp.json`, with `--allow-writes`
 * for the `write` tier, and `--allow-writes --allow-spend` for the `spend`
 * tier. The proofs, setups and cleanups run the built CLI (`bun run build`)
 * with the same profile. The summary goes to stdout as JSON. A Pages task
 * needs an active Pages site of that name in the organization.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

type Expression = string;
/** What one turn of a task must do: the tools it calls, the tools it never calls, and its answer. */
type Turn = { tools?: string[]; never?: string[]; answer?: string[] };
type Reply = Turn & { prompt: string };
type Task = Turn & {
  id: string;
  tier: "read" | "write" | "spend";
  prompt: string;
  tools: string[];
  replies?: Reply[];
  proof?: { command: string[]; expect?: Expression; check?: Expression; list?: boolean };
  setup?: { createSshKey?: string; createProject?: string; writeSite?: boolean };
  cleanup?: { sshKeysNamed?: string[]; projectsNamed?: string[]; livePacks?: boolean };
};

const { values } = parseArgs({
  options: {
    tier: { type: "string" },
    profile: { type: "string", default: "staging" },
    model: { type: "string", default: "oncloud_ai/anthropic/claude-sonnet-5-5" },
    thinking: { type: "string", default: "low" },
    concurrency: { type: "string", default: "4" },
    only: { type: "string" },
    "pages-site": { type: "string", default: "cli-eval" },
  },
});
if (values.tier !== "read" && values.tier !== "write" && values.tier !== "spend") {
  throw new Error("--tier must be read, write or spend");
}
// Spend tasks share one account balance and one list of packs, so one task's
// purchase would show in another's proof: they run one at a time.
const concurrency = values.tier === "spend" ? 1 : Number(values.concurrency);
/** The pack statuses that still renew, so a delete is due. */
const RENEWING_PACK: ReadonlySet<string> = new Set(["active", "renewal_grace", "suspended"]);

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "dist", "cli.js");
const LIST_COMMANDS = new Set([
  "billing transactions list",
  "compute list",
  "support tickets list",
]);
const runSuffix = Date.now().toString(36);

const document = Bun.YAML.parse(await Bun.file(join(import.meta.dir, "tasks.yaml")).text()) as {
  tasks: Task[];
};
const only = values.only ? new Set(values.only.split(",")) : undefined;
const tasks = document.tasks.filter(
  (task) => task.tier === values.tier && (!only || only.has(task.id)),
);

function sshPublicKey(comment: string): string {
  const der = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  const field = (bytes: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const blob = Buffer.concat([
    field(Buffer.from("ssh-ed25519")),
    field(der.subarray(der.length - 32)),
  ]);
  return `ssh-ed25519 ${blob.toString("base64")} ${comment}`;
}

async function lazco(
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["node", CLI, "--profile", values.profile as string, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function output(command: readonly string[], stdout: string, list?: boolean): unknown {
  const lines = stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  return list || LIST_COMMANDS.has(command.join(" ")) ? lines : lines[0];
}

function evaluate(expression: Expression, out: unknown): unknown {
  return new Function("out", `return (${expression});`)(out);
}

async function namedIds(command: string[], names: readonly string[]): Promise<string[]> {
  const run = await lazco(command);
  const out = output(command, run.stdout) as { data?: Array<{ id: string; name: string }> };
  return (out?.data ?? []).filter((item) => names.includes(item.name)).map((item) => item.id);
}

let pagesSiteId: Promise<string> | undefined;

/** The id of the Pages site the Pages tasks deploy to, read once. */
function pagesSite(): Promise<string> {
  pagesSiteId ??= (async () => {
    const run = await lazco(["labs", "pages", "sites", "list"]);
    const out = output(["labs", "pages", "sites", "list"], run.stdout) as {
      data?: Array<{ id: string; name: string; status: string }>;
    };
    const site = out?.data?.find((item) => item.name === values["pages-site"]);
    if (site?.status !== "active") {
      throw new Error(`no active Pages site named ${values["pages-site"]}`);
    }
    return site.id;
  })();
  return pagesSiteId;
}

/** A small site whose page names the run, so a deploy of it can be told apart. */
async function writeSite(directory: string, run: string): Promise<void> {
  await mkdir(join(directory, "css"), { recursive: true });
  await writeFile(
    join(directory, "index.html"),
    `<!doctype html><link rel="stylesheet" href="css/site.css"><h1>eval-${run}</h1>\n`,
  );
  await writeFile(join(directory, "css", "site.css"), "h1 { color: #0a7; }\n");
  await writeFile(join(directory, ".env"), "NOT_PUBLIC=1\n");
}

/** The ids of the Pages packs that still renew. */
async function livePackIds(): Promise<string[]> {
  const command = ["labs", "pages", "entitlement", "get"];
  const run = await lazco(command);
  if (run.code !== 0) {
    throw new Error(`labs pages entitlement get failed: ${run.stderr.trim()}`);
  }
  const out = output(command, run.stdout) as { packs?: Array<{ id: string; status: string }> };
  return (out?.packs ?? []).filter((pack) => RENEWING_PACK.has(pack.status)).map((pack) => pack.id);
}

/**
 * Deletes every Pages pack that still renews, and names each one still left.
 * A pack renews every month until it is deleted, and a delete refunds nothing.
 */
async function deleteLivePacks(): Promise<string[]> {
  for (const id of await livePackIds()) {
    await lazco(["labs", "pages", "packs", "delete", id, "--yes"]);
  }
  return (await livePackIds()).map((id) => `pack ${id} still renews`);
}

/** Deletes what a task made, and names whatever it could not delete. */
async function cleanup(task: Task): Promise<string[]> {
  // Packs first, because they cost money every month, and each step runs even when one before it fails.
  const steps: Array<() => Promise<string[]>> = [];
  if (task.cleanup?.livePacks) {
    steps.push(deleteLivePacks);
  }
  steps.push(async () => {
    for (const id of await namedIds(["ssh-keys", "list"], task.cleanup?.sshKeysNamed ?? [])) {
      await lazco(["ssh-keys", "delete", id]);
    }
    return [];
  });
  steps.push(async () => {
    for (const id of await namedIds(["projects", "list"], task.cleanup?.projectsNamed ?? [])) {
      await lazco(["projects", "delete", id, "--yes"]);
    }
    return [];
  });
  const problems: string[] = [];
  for (const step of steps) {
    try {
      problems.push(...(await step()));
    } catch (error) {
      problems.push(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}

/**
 * The tool calls and the last text of each turn of a `pi --mode json`
 * transcript, and every model error. A turn starts at a user message and
 * holds what the agent did before the next one.
 */
function readTranscript(text: string): {
  turns: Array<{ calls: string[]; answer: string }>;
  errors: string[];
} {
  const turns: Array<{ calls: string[]; answer: string }> = [];
  const errors: string[] = [];
  let lastWasError = false;
  for (const line of text.split("\n")) {
    let event: {
      type?: string;
      message?: {
        role?: string;
        content?: Array<Record<string, string>> | string;
        stopReason?: string;
        errorMessage?: string;
      };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    // pi retries a rate limit or an overload, so the error it retries is not the run's.
    if (event.type === "auto_retry_start") {
      if (lastWasError) errors.pop();
      lastWasError = false;
      continue;
    }
    if (event.type !== "message_end") continue;
    lastWasError = false;
    if (event.message?.role === "user") {
      turns.push({ calls: [], answer: "" });
      continue;
    }
    // pi exits 0 when the model answers an error, so the error is read here.
    if (event.message?.role === "assistant" && event.message.stopReason === "error") {
      errors.push(event.message.errorMessage ?? "no message");
      lastWasError = true;
    }
    const turn = turns.at(-1);
    const content = event.message?.content;
    if (event.message?.role !== "assistant" || turn === undefined || !Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (part.type === "toolCall" && part.name) {
        turn.calls.push(part.name.replace(/^(mcp__lazco__|lazco_)/, ""));
      }
      if (part.type === "text" && part.text) {
        turn.answer = part.text;
      }
    }
  }
  return { turns, errors };
}

/** The problems of one turn against what it must do. */
function gradeTurn(
  expected: Turn,
  turn: { calls: string[]; answer: string } | undefined,
  label: string,
): string[] {
  if (turn === undefined) {
    return [`${label}: the agent never reached it`];
  }
  const problems: string[] = [];
  const tools = expected.tools ?? [];
  if (tools.length > 0 && !tools.some((tool) => turn.calls.includes(tool))) {
    problems.push(`${label}: called none of ${tools.join(", ")}`);
  }
  for (const tool of expected.never ?? []) {
    if (turn.calls.includes(tool)) problems.push(`${label}: called ${tool}`);
  }
  for (const pattern of expected.answer ?? []) {
    if (!new RegExp(pattern, "i").test(turn.answer)) {
      problems.push(`${label}: answer does not match /${pattern}/`);
    }
  }
  return problems;
}

function contains(answer: string, expected: unknown): boolean {
  const normalized = answer.toLowerCase().replace(/[*`]/g, "");
  if (Array.isArray(expected)) {
    return expected.every((item) =>
      Array.isArray(item)
        ? item.some((choice) => normalized.includes(String(choice).toLowerCase()))
        : normalized.includes(String(item).toLowerCase()),
    );
  }
  return normalized.includes(String(expected).toLowerCase());
}

async function runTask(task: Task, index: number) {
  const run = `${runSuffix}${index}`;
  const fill = (text: string) => text.replaceAll("{run}", run);
  const key = sshPublicKey(`eval-${run}`);
  const problems: string[] = [];
  const workdir = await mkdtemp(join(tmpdir(), "lazco-eval-"));
  const siteDirectory = join(workdir, "site");
  const usesPages = JSON.stringify(task).includes("{pagesSite");
  let filled: Task = task;
  let result: {
    id: string;
    calls: string[];
    answer: string;
    turns: Array<{ calls: string[]; answer: string }> | undefined;
  } = { id: task.id, calls: [], answer: "", turns: undefined };
  try {
    const pagesSiteValue = usesPages ? await pagesSite() : "";
    filled = JSON.parse(
      fill(JSON.stringify(task))
        .replaceAll("{pagesSiteId}", pagesSiteValue)
        .replaceAll("{pagesSite}", values["pages-site"] as string)
        .replaceAll("{siteDir}", siteDirectory),
    );
    filled.prompt = filled.prompt.replaceAll("{key}", key);
    if (filled.setup?.writeSite) {
      await writeSite(siteDirectory, run);
    }
    if (filled.setup?.createSshKey) {
      const made = await lazco([
        "ssh-keys",
        "create",
        "--name",
        filled.setup.createSshKey,
        "--public-key",
        key,
      ]);
      if (made.code !== 0) problems.push(`setup failed: ${made.stderr.trim()}`);
    }
    if (filled.setup?.createProject) {
      const made = await lazco(["projects", "create", "--name", filled.setup.createProject]);
      if (made.code !== 0) problems.push(`setup failed: ${made.stderr.trim()}`);
    }
    if (filled.cleanup?.livePacks) {
      // A pack left by an earlier run would pass a proof that counts packs.
      for (const left of await deleteLivePacks()) problems.push(`setup failed: ${left}`);
    }
    if (problems.length > 0) {
      // The agent never runs, and so never spends, in a state the setup could not make.
      throw new Error("the setup failed, so the agent did not run");
    }
    const replies = filled.replies ?? [];
    // Each reply is one more user message in the same session, sent after the agent answers.
    const agent = Bun.spawn(
      [
        "pi",
        "-p",
        "--mode",
        "json",
        "--no-session",
        "--no-builtin-tools",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--model",
        values.model as string,
        "--thinking",
        values.thinking as string,
        // The answers are graded in English, whatever language the user's own rules ask for.
        "--append-system-prompt",
        "Answer in English.",
        "--",
        filled.prompt,
        ...replies.map((reply) => reply.prompt),
      ],
      { cwd: workdir, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    const timer = setTimeout(() => agent.kill(), 300_000 * (1 + replies.length));
    const transcript = await new Response(agent.stdout).text();
    const exitCode = await agent.exited;
    clearTimeout(timer);
    if (exitCode !== 0) problems.push(`pi exited with ${exitCode}`);
    const { turns, errors } = readTranscript(transcript);
    for (const error of new Set(errors)) problems.push(`the model failed: ${error}`);
    const calls = turns.flatMap((turn) => turn.calls);
    const answer = turns.at(-1)?.answer ?? "";
    // Set before the proof, so a proof that throws still shows what the agent did.
    result = {
      id: task.id,
      calls,
      answer: answer.slice(0, 400),
      turns:
        replies.length === 0
          ? undefined
          : turns.map((turn) => ({ calls: turn.calls, answer: turn.answer.slice(0, 400) })),
    };
    if (replies.length === 0) {
      problems.push(...gradeTurn(filled, { calls, answer }, "run"));
    } else {
      problems.push(...gradeTurn(filled, turns[0], "prompt"));
      replies.forEach((reply, index) => {
        problems.push(...gradeTurn(reply, turns[index + 1], `reply ${index + 1}`));
      });
    }
    if (filled.proof) {
      const proof = await lazco(filled.proof.command);
      if (proof.code !== 0) {
        problems.push(`proof failed: ${proof.stderr.trim()}`);
      } else {
        const out = output(filled.proof.command, proof.stdout, filled.proof.list);
        if (filled.proof.expect) {
          const expected = evaluate(filled.proof.expect, out);
          if (!contains(answer, expected))
            problems.push(`answer lacks ${JSON.stringify(expected)}`);
        }
        if (filled.proof.check && evaluate(filled.proof.check, out) !== true) {
          problems.push(`check is false: ${filled.proof.check}`);
        }
      }
    }
  } catch (error) {
    problems.push(`the runner failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // What the cleanup cannot delete, such as a pack that still renews, fails the task.
  try {
    problems.push(...(await cleanup(filled)));
  } catch (error) {
    problems.push(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await rm(workdir, { recursive: true, force: true });
  return { ...result, pass: problems.length === 0, problems };
}

const results: Awaited<ReturnType<typeof runTask>>[] = [];
const queue = tasks.map((task, index) => ({ task, index }));
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const result = await runTask(next.task, next.index);
      console.error(`${result.pass ? "PASS" : "FAIL"} ${result.id} ${result.problems.join("; ")}`);
      results.push(result);
    }
  }),
);
results.sort((left, right) => left.id.localeCompare(right.id));
console.log(
  JSON.stringify(
    {
      tier: values.tier,
      passed: results.filter((r) => r.pass).length,
      total: results.length,
      results,
    },
    null,
    2,
  ),
);
