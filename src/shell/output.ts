import { type ErrorBody, redactSecrets } from "../core/errors";
import type { Io } from "./io";

export type OutputOptions = {
  human: boolean;
  fields: readonly string[] | undefined;
  /** Values that never reach output, such as the active credential. */
  secrets: readonly string[];
};

/** Keeps only the named top-level fields, in the order named. A name no record has is ignored. */
export function pickFields(record: unknown, fields: readonly string[] | undefined): unknown {
  if (!fields || record === null || typeof record !== "object" || Array.isArray(record)) {
    return record;
  }
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.hasOwn(record, field)) {
      picked[field] = (record as Record<string, unknown>)[field];
    }
  }
  return picked;
}

/** Text safe for a terminal: control characters, escape codes among them, become visible. */
function terminalSafe(text: string): string {
  let safe = "";
  for (const character of text) {
    const code = character.charCodeAt(0);
    const control =
      (code <= 0x1f && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
    safe += control ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  }
  return safe;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return terminalSafe(typeof value === "string" ? value : JSON.stringify(value));
}

function colorsOn(io: Io, stream: { isTTY?: boolean }): boolean {
  return Boolean(stream.isTTY) && io.env.NO_COLOR === undefined;
}

function humanTable(items: readonly unknown[], io: Io): string {
  if (items.length === 0) {
    return "";
  }
  const records = items.map((item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : { value: item },
  );
  const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const rows = records.map((record) =>
    columns.map((column) => cellText(record[column]).replace(/\n/g, " ")),
  );
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => (row[index] as string).length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] as number))
      .join("  ")
      .trimEnd();
  const header = line(columns.map((column) => column.toUpperCase()));
  const bold = colorsOn(io, io.stdout) ? `\u001b[1m${header}\u001b[0m` : header;
  return `${[bold, ...rows.map(line)].join("\n")}\n`;
}

function humanRecord(record: unknown): string {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return `${cellText(record)}\n`;
  }
  const entries = Object.entries(record);
  const width = Math.max(0, ...entries.map(([key]) => key.length));
  return entries
    .map(([key, value]) => `${`${terminalSafe(key)}:`.padEnd(width + 1)} ${cellText(value)}\n`)
    .join("");
}

/** Writes the answer of a command: one JSON object, or NDJSON for a list. */
export function writeResult(
  io: Io,
  result: { list: readonly unknown[] } | { record: unknown },
  options: OutputOptions,
): void {
  if ("list" in result) {
    const items = redactSecrets(
      result.list.map((item) => pickFields(item, options.fields)),
      options.secrets,
    );
    io.stdout.write(
      options.human
        ? humanTable(items, io)
        : items.map((item) => `${JSON.stringify(item)}\n`).join(""),
    );
    return;
  }
  const record = redactSecrets(pickFields(result.record, options.fields), options.secrets);
  io.stdout.write(options.human ? humanRecord(record) : `${JSON.stringify(record)}\n`);
}

/** Writes one error line to stderr: JSON, or one colored line with `--human`. */
export function writeError(
  io: Io,
  body: ErrorBody,
  options: Pick<OutputOptions, "human" | "secrets">,
): void {
  const safe = redactSecrets(body, options.secrets);
  if (!options.human) {
    io.stderr.write(`${JSON.stringify({ error: safe })}\n`);
    return;
  }
  const { code, message, status, details, ...rest } = safe;
  const others = details === undefined ? rest : { details, ...rest };
  const extra = Object.keys(others).length === 0 ? "" : ` ${JSON.stringify(others)}`;
  const text = terminalSafe(
    `error ${code}${status === undefined ? "" : ` (${status})`}: ${message}${extra}`,
  );
  io.stderr.write(colorsOn(io, io.stderr) ? `\u001b[31m${text}\u001b[0m\n` : `${text}\n`);
}

/** A warning or progress line on stderr. Never on stdout, which is only for the answer. */
export function writeNotice(io: Io, message: string): void {
  io.stderr.write(`lazco: ${terminalSafe(message)}\n`);
}
