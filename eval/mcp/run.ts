/**
 * Runs the MCP evaluation set through `pi` and grades each task.
 *
 *   bun eval/mcp/run.ts --tier read [--profile staging] [--model <model>] [--concurrency 4] [--only id,id]
 *
 * Before a run, `lazco mcp install --client pi --profile <profile>` must have
 * written the `lazco` entry of `~/.pi/agent/mcp.json`, with `--allow-writes`
 * for the `write` tier. The proofs, setups and cleanups run the built CLI
 * (`bun run build`) with the same profile. The summary goes to stdout as JSON.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

type Expression = string;
type Task = {
  id: string;
  tier: "read" | "write";
  prompt: string;
  tools: string[];
  proof?: { command: string[]; expect?: Expression; check?: Expression; list?: boolean };
  answer?: string[];
  setup?: { createSshKey?: string; createProject?: string };
  cleanup?: { sshKeysNamed?: string[]; projectsNamed?: string[] };
};

const { values } = parseArgs({
  options: {
    tier: { type: "string" },
    profile: { type: "string", default: "staging" },
    model: { type: "string", default: "oncloud_ai/~openrouter/claude-sonnet-latest" },
    thinking: { type: "string", default: "low" },
    concurrency: { type: "string", default: "4" },
    only: { type: "string" },
  },
});
if (values.tier !== "read" && values.tier !== "write") {
  throw new Error("--tier must be read or write");
}

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

async function cleanup(task: Task): Promise<void> {
  for (const id of await namedIds(["ssh-keys", "list"], task.cleanup?.sshKeysNamed ?? [])) {
    await lazco(["ssh-keys", "delete", id]);
  }
  for (const id of await namedIds(["projects", "list"], task.cleanup?.projectsNamed ?? [])) {
    await lazco(["projects", "delete", id, "--yes"]);
  }
}

/** The tool calls and the last text of a `pi --mode json` transcript. */
function readTranscript(text: string): { calls: string[]; answer: string } {
  const calls: string[] = [];
  let answer = "";
  for (const line of text.split("\n")) {
    let event: {
      type?: string;
      message?: { role?: string; content?: Array<Record<string, string>> };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
    for (const content of event.message.content ?? []) {
      if (content.type === "toolCall" && content.name) {
        calls.push(content.name.replace(/^(mcp__lazco__|lazco_)/, ""));
      }
      if (content.type === "text" && content.text) {
        answer = content.text;
      }
    }
  }
  return { calls, answer };
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
  const filled: Task = JSON.parse(fill(JSON.stringify(task)));
  filled.prompt = filled.prompt.replaceAll("{key}", key);
  const problems: string[] = [];
  const workdir = await mkdtemp(join(tmpdir(), "lazco-eval-"));
  try {
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
        filled.prompt,
      ],
      { cwd: workdir, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    const timer = setTimeout(() => agent.kill(), 300_000);
    const transcript = await new Response(agent.stdout).text();
    const exitCode = await agent.exited;
    clearTimeout(timer);
    if (exitCode !== 0) problems.push(`pi exited with ${exitCode}`);
    const { calls, answer } = readTranscript(transcript);
    if (filled.tools.length > 0 && !filled.tools.some((tool) => calls.includes(tool))) {
      problems.push(`called none of ${filled.tools.join(", ")}`);
    }
    for (const pattern of filled.answer ?? []) {
      if (!new RegExp(pattern, "i").test(answer))
        problems.push(`answer does not match /${pattern}/`);
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
    return {
      id: task.id,
      pass: problems.length === 0,
      calls,
      problems,
      answer: answer.slice(0, 400),
    };
  } catch (error) {
    problems.push(`the runner failed: ${error instanceof Error ? error.message : String(error)}`);
    return { id: task.id, pass: false, calls: [], problems, answer: "" };
  } finally {
    await cleanup(filled);
    await rm(workdir, { recursive: true, force: true });
  }
}

const results: Awaited<ReturnType<typeof runTask>>[] = [];
const queue = tasks.map((task, index) => ({ task, index }));
await Promise.all(
  Array.from({ length: Number(values.concurrency) }, async () => {
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
