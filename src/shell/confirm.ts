import { createInterface } from "node:readline/promises";
import { CliError } from "../core/errors";
import type { OperationKind } from "../core/generate/annotation";
import { canPrompt, type Io } from "./io";

export type ConfirmTarget = {
  command: readonly string[];
  kind: OperationKind;
  /** The input that must hold the resource name, from `x-lazco.confirm`. */
  confirmField: string | undefined;
};

async function ask(io: Io, question: string): Promise<string> {
  const prompt = createInterface({
    input: io.stdin,
    output: io.stderr as NodeJS.WritableStream,
    terminal: true,
  });
  try {
    return (await prompt.question(question)).trim();
  } finally {
    prompt.close();
  }
}

/**
 * A destructive or spend command runs only with a confirmation: `--yes`, or
 * an answer on a terminal. With a `confirm` field, the user types the resource
 * name and it goes into that field. The CLI never fills the field itself,
 * because the API's own check that the name matches is the point.
 */
export async function confirmCommand(
  target: ConfirmTarget,
  input: Record<string, unknown>,
  options: { io: Io; yes: boolean; flagOf: (property: string) => string },
): Promise<Record<string, unknown>> {
  if (target.kind !== "destructive" && target.kind !== "spend") {
    return input;
  }
  const command = target.command.join(" ");
  const field = target.confirmField;
  const missingName = field !== undefined && (input[field] === undefined || input[field] === "");
  if (options.yes) {
    if (missingName) {
      throw new CliError(
        "CLI_CONFIRM_REQUIRED",
        `${command} needs the resource name in ${options.flagOf(field)}`,
        {
          field,
        },
      );
    }
    return input;
  }
  if (!canPrompt(options.io)) {
    throw new CliError(
      "CLI_CONFIRM_REQUIRED",
      `${command} is ${target.kind}: give --yes to run it without a terminal`,
      {
        kind: target.kind,
      },
    );
  }
  if (missingName) {
    const name = await ask(
      options.io,
      `${command} is ${target.kind}. Type the resource name to confirm (${field}): `,
    );
    if (!name) {
      throw new CliError("CLI_CONFIRM_REQUIRED", `${command} was not confirmed`, { field });
    }
    return { ...input, [field]: name };
  }
  const answer = (
    await ask(options.io, `${command} is ${target.kind}. Continue? [y/N] `)
  ).toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    throw new CliError("CLI_CONFIRM_REQUIRED", `${command} was not confirmed`, {
      kind: target.kind,
    });
  }
  return input;
}
