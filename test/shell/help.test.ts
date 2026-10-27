import { describe, expect, test } from "bun:test";
import { hiddenCommandsNotice } from "../../src/shell/help";

const entry = (command: string, feature: string | null) => ({
  command: command.split(" "),
  feature,
});

describe("hiddenCommandsNotice", () => {
  test("one line per feature, the commands sorted", () => {
    const lines = hiddenCommandsNotice([
      entry("compute ptr set", "reverseDns"),
      entry("network-resources ptr list", "networkResources"),
      entry("compute extra-ips ptr list", "reverseDns"),
      entry("compute ptr list", "reverseDns"),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith(
      '1 command is hidden because the organization\'s feature "networkResources" is off: network-resources ptr list.',
    );
    expect(lines[1]).toStartWith(
      '3 commands are hidden because the organization\'s feature "reverseDns" is off: compute extra-ips ptr list, compute ptr list, compute ptr set.',
    );
  });

  test("names six and counts the rest", () => {
    const hidden = Array.from({ length: 9 }, (_, index) => entry(`pages c${index}`, "pages"));
    const [line] = hiddenCommandsNotice(hidden);
    expect(line).toContain(
      "pages c0, pages c1, pages c2, pages c3, pages c4, pages c5 and 3 more.",
    );
  });

  test("nothing hidden, no line", () => {
    expect(hiddenCommandsNotice([])).toEqual([]);
    expect(hiddenCommandsNotice([entry("compute list", null)])).toEqual([]);
  });
});
