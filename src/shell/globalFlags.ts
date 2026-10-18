import { CliError } from "../core/errors";
import { DEFAULT_WAIT_SECONDS } from "../core/request/execute";
import { DEFAULT_API_URL, normalizeApiUrl } from "./apiUrl";

export type GlobalFlags = {
  apiUrl: string;
  human: boolean;
  fields: string[] | undefined;
  pageAll: boolean;
  json: string | undefined;
  describe: boolean;
  dryRun: boolean;
  yes: boolean;
  wait: boolean;
  timeoutSeconds: number;
  help: boolean;
  version: boolean;
};

type GlobalFlagSpec = {
  name: string;
  takesValue: boolean;
  valueHint?: string;
  description: string;
};

/** Every global flag. A command's own input with one of these names is reachable through `--json` only. */
export const GLOBAL_FLAGS: readonly GlobalFlagSpec[] = [
  {
    name: "api-url",
    takesValue: true,
    valueHint: "url",
    description: `The API base URL (default ${DEFAULT_API_URL})`,
  },
  {
    name: "json",
    takesValue: true,
    valueHint: "payload",
    description: "The whole input as JSON, or - to read it from stdin",
  },
  {
    name: "fields",
    takesValue: true,
    valueHint: "a,b",
    description: "Keep only these top-level fields of each record",
  },
  {
    name: "timeout",
    takesValue: true,
    valueHint: "seconds",
    description: `How long to wait for a task (default ${DEFAULT_WAIT_SECONDS})`,
  },
  { name: "human", takesValue: false, description: "Print readable text instead of JSON" },
  { name: "page-all", takesValue: false, description: "Follow every page of a list" },
  {
    name: "describe",
    takesValue: false,
    description: "Print the command and its input as JSON Schema",
  },
  {
    name: "dry-run",
    takesValue: false,
    description: "Check the input and print the request without sending it",
  },
  {
    name: "yes",
    takesValue: false,
    description: "Confirm a destructive or spend command without asking",
  },
  { name: "wait", takesValue: false, description: "Wait for a task to end (default)" },
  { name: "no-wait", takesValue: false, description: "Print the accepted task at once" },
  { name: "help", takesValue: false, description: "Show usage" },
  { name: "version", takesValue: false, description: "Show the version" },
];

const BY_NAME = new Map(GLOBAL_FLAGS.map((flag) => [flag.name, flag]));

export function isGlobalFlagName(name: string): boolean {
  return BY_NAME.has(name);
}

function invalid(message: string, field: string): CliError {
  return new CliError("CLI_INVALID_INPUT", message, [{ field, message }]);
}

/**
 * Takes the global flags out of the arguments wherever they stand, and leaves
 * the command words, positionals and command flags in order. Everything after
 * `--` is left alone.
 */
export function extractGlobalFlags(argv: readonly string[]): {
  flags: GlobalFlags;
  rest: string[];
} {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === "--") {
      rest.push(...argv.slice(index));
      break;
    }
    if (token === "-h") {
      switches.add("help");
      continue;
    }
    const match = /^--([a-z][a-z0-9-]*)(?:=([\s\S]*))?$/.exec(token);
    const spec = match ? BY_NAME.get(match[1] as string) : undefined;
    if (!match || !spec) {
      rest.push(token);
      continue;
    }
    const inline = match[2];
    if (!spec.takesValue) {
      if (inline !== undefined) {
        throw invalid(`--${spec.name} takes no value`, spec.name);
      }
      switches.add(spec.name);
      continue;
    }
    if (values.has(spec.name)) {
      throw invalid(`--${spec.name} is given twice`, spec.name);
    }
    const value = inline ?? argv[index + 1];
    if (value === undefined) {
      throw invalid(`--${spec.name} needs a value`, spec.name);
    }
    if (inline === undefined) {
      index += 1;
    }
    values.set(spec.name, value);
  }

  if (switches.has("wait") && switches.has("no-wait")) {
    throw invalid("--wait and --no-wait cannot both be given", "wait");
  }
  let timeoutSeconds = DEFAULT_WAIT_SECONDS;
  const timeout = values.get("timeout");
  if (timeout !== undefined) {
    timeoutSeconds = Number(timeout);
    if (!/^\d+$/.test(timeout) || timeoutSeconds < 1) {
      throw invalid("--timeout must be a whole number of seconds, 1 or more", "timeout");
    }
  }
  const fields = values.get("fields");
  return {
    flags: {
      apiUrl: normalizeApiUrl(values.get("api-url") ?? DEFAULT_API_URL),
      human: switches.has("human"),
      fields:
        fields === undefined
          ? undefined
          : fields
              .split(",")
              .map((field) => field.trim())
              .filter(Boolean),
      pageAll: switches.has("page-all"),
      json: values.get("json"),
      describe: switches.has("describe"),
      dryRun: switches.has("dry-run"),
      yes: switches.has("yes"),
      wait: !switches.has("no-wait"),
      timeoutSeconds,
      help: switches.has("help"),
      version: switches.has("version"),
    },
    rest,
  };
}
