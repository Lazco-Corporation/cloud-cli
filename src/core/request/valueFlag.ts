import { CliError } from "../errors";

/**
 * Takes one operation flag with a value, `--name VALUE` or `--name=VALUE`,
 * out of a command's arguments before `--`, and returns the rest. An
 * operation flag is never an input property. The value goes through `check`.
 */
export function extractValueFlag(
  tokens: readonly string[],
  name: string,
  check: (value: string) => string,
): { value: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^--${escaped}(?:=([\\s\\S]*))?$`);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token === "--") {
      rest.push(...tokens.slice(index));
      break;
    }
    const match = pattern.exec(token);
    if (!match) {
      rest.push(token);
      continue;
    }
    if (value !== undefined) {
      throw flagProblem(name, `--${name} is given twice`);
    }
    const next = tokens[index + 1];
    // `--name --yes` forgot the value: never take the next flag as the value.
    const given = match[1] ?? (next?.startsWith("--") ? undefined : next);
    if (given === undefined) {
      throw flagProblem(name, `--${name} needs a value`);
    }
    if (match[1] === undefined) {
      index += 1;
    }
    value = check(given);
  }
  return { value, rest };
}

export function flagProblem(name: string, message: string): CliError {
  return new CliError("CLI_INVALID_INPUT", message, [{ field: name, message }]);
}
