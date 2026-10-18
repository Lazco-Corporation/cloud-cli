import { type ArgsDef, type CommandDef, renderUsage } from "citty";
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
