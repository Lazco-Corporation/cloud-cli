import { describe, expect, test } from "bun:test";
import { HANDWRITTEN_COMMANDS } from "../../src/commands/registry";
import { RESERVED_FIRST_WORDS } from "../../src/core/generate/operations";

describe("the hand-written commands", () => {
  test("their first words are exactly the words the generator reserves", () => {
    const firstWords = new Set(HANDWRITTEN_COMMANDS.map((command) => command.command[0]));
    expect([...firstWords].sort()).toEqual([...RESERVED_FIRST_WORDS].sort());
  });
});
