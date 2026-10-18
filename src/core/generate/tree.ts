import type { Operation } from "./operations";

export type TreeEntry = { command: readonly string[] };

export type Resolution<T> =
  | { kind: "command"; entry: T; consumed: number }
  | { kind: "group"; group: readonly string[]; children: readonly string[] }
  | { kind: "unknown"; words: readonly string[] };

/** The commands as a tree of words, for generated and hand-written commands alike. */
export class CommandTree<T extends TreeEntry> {
  private readonly entries = new Map<string, T>();
  private readonly childWords = new Map<string, Set<string>>();

  constructor(entries: readonly T[]) {
    for (const entry of entries) {
      this.entries.set(entry.command.join(" "), entry);
      for (let depth = 0; depth < entry.command.length; depth += 1) {
        const parent = entry.command.slice(0, depth).join(" ");
        const words = this.childWords.get(parent) ?? new Set<string>();
        words.add(entry.command[depth] as string);
        this.childWords.set(parent, words);
      }
    }
  }

  get all(): readonly T[] {
    return [...this.entries.values()];
  }

  /** The words that follow a prefix, sorted. */
  children(prefix: readonly string[]): string[] {
    return [...(this.childWords.get(prefix.join(" ")) ?? [])].sort();
  }

  /** The entries at or below a prefix. */
  below(prefix: readonly string[]): T[] {
    const key = prefix.join(" ");
    return this.all.filter((entry) => {
      const command = entry.command.join(" ");
      return key === "" || command === key || command.startsWith(`${key} `);
    });
  }

  /** The longest command that the leading words name, or the group they stop in. */
  resolve(words: readonly string[]): Resolution<T> {
    let match: { entry: T; consumed: number } | undefined;
    let depth = 0;
    while (
      depth < words.length &&
      this.childWords.get(words.slice(0, depth).join(" "))?.has(words[depth] as string)
    ) {
      depth += 1;
      const entry = this.entries.get(words.slice(0, depth).join(" "));
      if (entry) {
        match = { entry, consumed: depth };
      }
    }
    if (match) {
      return { kind: "command", ...match };
    }
    if (depth > 0) {
      const group = words.slice(0, depth);
      return { kind: "group", group, children: this.children(group) };
    }
    return { kind: "unknown", words };
  }
}

/** The operations that have an MCP tool, sorted by tool name. */
export function toolOperations(operations: readonly Operation[]): Operation[] {
  return operations
    .filter((operation) => operation.toolName !== null)
    .sort((left, right) => (left.toolName as string).localeCompare(right.toolName as string));
}
