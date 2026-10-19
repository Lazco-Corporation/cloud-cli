import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  errorOf,
  KEY_NAME_PREFIX,
  lazco,
  READ_TOKEN,
  type Run,
  sshPublicKey,
  stagingFeatures,
  stagingOperations,
  temporaryHome,
  WRITE_TOKEN,
} from "./staging";

const TIMEOUT_MS = 120_000;

const operations = await stagingOperations();
const features = await stagingFeatures(READ_TOKEN);
let home: Awaited<ReturnType<typeof temporaryHome>>;

type SshKey = { id: string; name: string };

function lines(run: Run): unknown[] {
  return run.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

async function listKeys(): Promise<SshKey[]> {
  const run = await lazco(home.home, WRITE_TOKEN, ["ssh-keys", "list"]);
  expect(run.code).toBe(0);
  const output = lines(run);
  const list = output.length === 1 && !Array.isArray(output[0]) ? output[0] : output;
  const keys = (list as { data?: SshKey[] }).data ?? (list as SshKey[]);
  return Array.isArray(keys) ? keys : [];
}

/** Deletes every key an earlier run left behind, such as one a cancelled run never deleted. */
async function deleteLeftoverKeys(): Promise<void> {
  for (const key of await listKeys()) {
    if (key.name.startsWith(KEY_NAME_PREFIX)) {
      await lazco(home.home, WRITE_TOKEN, ["ssh-keys", "delete", key.id]);
    }
  }
}

beforeAll(async () => {
  home = await temporaryHome();
  await deleteLeftoverKeys();
}, TIMEOUT_MS);

afterAll(async () => {
  await deleteLeftoverKeys();
  await home.cleanup();
}, TIMEOUT_MS);

describe("every read operation that needs no input", () => {
  const reads = operations.filter(
    (operation) =>
      operation.kind === "read" &&
      ((operation.inputSchema.required as string[] | undefined) ?? []).length === 0,
  );

  test("the staging spec has some", () => {
    expect(reads.length).toBeGreaterThan(20);
  });

  for (const operation of reads) {
    const command = operation.command.join(" ");
    const off = operation.feature !== null && features[operation.feature] === false;
    test(
      off
        ? `${command} still runs with ${operation.feature} off and passes the API's answer through`
        : `${command} answers JSON`,
      async () => {
        const run = await lazco(home.home, READ_TOKEN, operation.command);
        if (off && run.code !== 0) {
          // The CLI never refuses a command whose feature is off: the API decides.
          expect(run.stdout).toBe("");
          const error = errorOf(run);
          expect(error.status).toBe(403);
          expect(error.code.startsWith("CLI_")).toBe(false);
          return;
        }
        expect({ command, code: run.code, stderr: run.stderr }).toEqual({
          command,
          code: 0,
          stderr: run.stderr.includes("more results") ? run.stderr : "",
        });
        expect(lines(run).length).toBeGreaterThanOrEqual(0);
      },
      TIMEOUT_MS,
    );
  }
});

describe("an SSH key round trip", () => {
  test(
    "create, read in the list, delete, and gone from the list",
    async () => {
      const name = `${KEY_NAME_PREFIX}${Date.now()}-${process.pid}`;
      const created = await lazco(home.home, WRITE_TOKEN, [
        "ssh-keys",
        "create",
        "--name",
        name,
        "--public-key",
        sshPublicKey(name),
      ]);
      expect({ code: created.code, stderr: created.stderr }).toEqual({ code: 0, stderr: "" });
      const key = JSON.parse(created.stdout) as SshKey;
      expect(key.name).toBe(name);

      expect((await listKeys()).map((entry) => entry.id)).toContain(key.id);

      const deleted = await lazco(home.home, WRITE_TOKEN, ["ssh-keys", "delete", key.id]);
      expect({ code: deleted.code, stderr: deleted.stderr }).toEqual({ code: 0, stderr: "" });
      expect((await listKeys()).map((entry) => entry.id)).not.toContain(key.id);
    },
    TIMEOUT_MS,
  );

  test(
    "a read token cannot create one, and the API's refusal passes through",
    async () => {
      const name = `${KEY_NAME_PREFIX}read-${Date.now()}`;
      const run = await lazco(home.home, READ_TOKEN, [
        "ssh-keys",
        "create",
        "--name",
        name,
        "--public-key",
        sshPublicKey(name),
      ]);
      expect(run.code).toBe(1);
      expect(errorOf(run).status).toBe(403);
    },
    TIMEOUT_MS,
  );
});

describe("errors", () => {
  test(
    "a token the API does not know is its own 401",
    async () => {
      const run = await lazco(home.home, `lz_live_${"0".repeat(64)}`, ["whoami"]);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe("");
      const error = errorOf(run);
      expect(error.status).toBe(401);
      expect(error.code.startsWith("CLI_")).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "a server that does not exist is the API's 404",
    async () => {
      const run = await lazco(home.home, READ_TOKEN, [
        "compute",
        "get",
        "00000000-0000-4000-8000-000000000000",
      ]);
      expect(run.code).toBe(1);
      expect(errorOf(run).status).toBe(404);
    },
    TIMEOUT_MS,
  );

  test(
    "a path parameter with .. is CLI_INVALID_INPUT before any request",
    async () => {
      const run = await lazco(home.home, READ_TOKEN, ["compute", "get", "../whoami"]);
      expect(run.code).toBe(1);
      expect(errorOf(run).code).toBe("CLI_INVALID_INPUT");
    },
    TIMEOUT_MS,
  );

  test(
    "an input the schema refuses is CLI_INVALID_INPUT with the field",
    async () => {
      const run = await lazco(home.home, READ_TOKEN, ["compute", "list", "--limit", "1000"]);
      expect(run.code).toBe(1);
      const error = errorOf(run);
      expect(error.code).toBe("CLI_INVALID_INPUT");
      expect(JSON.stringify(error.details)).toContain("limit");
    },
    TIMEOUT_MS,
  );
});

describe("pagination", () => {
  test(
    "--page-all walks every page of a page-numbered list",
    async () => {
      const first = await lazco(home.home, READ_TOKEN, ["billing", "transactions", "list"]);
      expect(first.code).toBe(0);
      const walked = await lazco(home.home, READ_TOKEN, [
        "billing",
        "transactions",
        "list",
        "--limit",
        "1",
        "--page-all",
      ]);
      expect(walked.code).toBe(0);
      expect(walked.stderr).toContain("page 1,");
      expect(lines(walked).length).toBe(lines(first).length);
    },
    TIMEOUT_MS,
  );

  test(
    "--page-all on a cursor list stops at a null cursor",
    async () => {
      const run = await lazco(home.home, READ_TOKEN, [
        "compute",
        "list",
        "--limit",
        "1",
        "--page-all",
      ]);
      expect(run.code).toBe(0);
      expect(run.stderr).toContain("page 1,");
    },
    TIMEOUT_MS,
  );
});
