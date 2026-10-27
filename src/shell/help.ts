import { type ArgsDef, type CommandDef, renderUsage } from "citty";
import { EXPECTED_AMOUNT_FLAG, QUOTE_ID_FLAG } from "../core/quote";
import { IDEMPOTENCY_KEY_FLAG } from "../core/request/idempotency";
import type { CommandEntry } from "./entries";
import { GLOBAL_FLAGS } from "./globalFlags";
import { flagSpecs } from "./input";

const VALUE_HINTS = {
  string: "text",
  number: "number",
  integer: "integer",
  boolean: "",
  auto: "value",
} as const;

function globalArgs(): ArgsDef {
  return Object.fromEntries(
    GLOBAL_FLAGS.map((flag) => [
      flag.name,
      flag.takesValue
        ? { type: "string" as const, description: flag.description, valueHint: flag.valueHint }
        : { type: "boolean" as const, description: flag.description },
    ]),
  );
}

/** citty's usage text of one command. */
export async function commandUsage(entry: CommandEntry): Promise<string> {
  const args: ArgsDef = {};
  for (const positional of entry.positionals) {
    args[positional] = { type: "positional", required: true, description: "" };
  }
  for (const spec of flagSpecs(entry.inputSchema, entry.positionals)) {
    args[spec.flag] =
      spec.kind === "boolean" && !spec.repeated
        ? { type: "boolean", description: spec.description, required: spec.required }
        : {
            type: "string",
            description: `${spec.description}${spec.repeated ? " (repeat for more)" : ""}`.trim(),
            valueHint: VALUE_HINTS[spec.kind],
            required: spec.required,
          };
  }
  Object.assign(args, operationFlags(entry));
  const definition: CommandDef = {
    meta: {
      name: `lazco ${entry.command.join(" ")}`,
      description: entry.summary || entry.command.join(" "),
    },
    args,
  };
  const usage = await renderUsage(definition);
  return `${usage}\n\nOther input goes in --json. Run with --describe for the JSON Schema.\n`;
}

/**
 * The flags that belong to the operation, not to its input: `--yes` for a
 * command that asks first, `--idempotency-key` where the spec requires the
 * header, and `--quote-id` with `--expected-amount` for a spend command.
 */
function operationFlags(entry: CommandEntry): ArgsDef {
  const operation = entry.source.type === "operation" ? entry.source.operation : undefined;
  if (operation === undefined) {
    return {};
  }
  const args: ArgsDef = {};
  if (operation.kind === "destructive" || operation.kind === "spend") {
    args.yes = { type: "boolean", description: "Run it without asking to confirm" };
  }
  if (operation.idempotencyKey === "required") {
    args[IDEMPOTENCY_KEY_FLAG] = {
      type: "string",
      valueHint: "key",
      description:
        "The Idempotency-Key to send (default: a new UUID). Run again with the same key to get the first result, not a second run",
    };
  }
  if (operation.kind === "spend") {
    args[QUOTE_ID_FLAG] = {
      type: "string",
      valueHint: "id",
      description:
        "Spend with a quote you already have, such as quote.quoteId of a --dry-run, and ask for no new one. Needs --expected-amount",
    };
    args[EXPECTED_AMOUNT_FLAG] = {
      type: "string",
      valueHint: "amount",
      description: "The amount of the quote of --quote-id, unchanged, such as 402.500",
    };
  }
  return args;
}

/** citty's usage text of a group, or of `lazco` itself when the prefix is empty. */
export async function groupUsage(
  prefix: readonly string[],
  children: ReadonlyArray<{ word: string; summary: string }>,
): Promise<string> {
  const subCommands = Object.fromEntries(
    children.map((child) => [child.word, { meta: { description: child.summary } }]),
  );
  const definition: CommandDef = {
    meta: {
      name: ["lazco", ...prefix].join(" "),
      description:
        prefix.length === 0
          ? "Lazco Cloud CLI and local MCP server"
          : `${prefix.join(" ")} commands`,
    },
    args: prefix.length === 0 ? globalArgs() : {},
    subCommands,
  };
  return `${await renderUsage(definition)}\n`;
}

/** How many hidden commands one feature's notice names before it says how many more. */
const HIDDEN_NAMED_MAX = 6;

/**
 * The notice `--help` writes to stderr for the commands under a group that it
 * left out because the organization's feature is off, one line per feature,
 * or none. Without it a group whose commands are all hidden lists nothing, and
 * nothing says why.
 */
export function hiddenCommandsNotice(
  hidden: ReadonlyArray<Pick<CommandEntry, "command" | "feature">>,
): string[] {
  const byFeature = new Map<string, string[]>();
  for (const entry of hidden) {
    if (entry.feature === null) continue;
    const names = byFeature.get(entry.feature) ?? [];
    names.push(entry.command.join(" "));
    byFeature.set(entry.feature, names);
  }
  return [...byFeature.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([feature, names]) => {
      const sorted = [...names].sort((left, right) => left.localeCompare(right));
      const named = sorted.slice(0, HIDDEN_NAMED_MAX).join(", ");
      const more =
        sorted.length > HIDDEN_NAMED_MAX ? ` and ${sorted.length - HIDDEN_NAMED_MAX} more` : "";
      const count = sorted.length === 1 ? "1 command is" : `${sorted.length} commands are`;
      return `${count} hidden because the organization's feature "${feature}" is off: ${named}${more}. They still run by name, and the API answers whether the organization may use them. The features are read again after 10 minutes.`;
    });
}
