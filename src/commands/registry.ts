import { AUTH_COMMANDS } from "./auth";
import { MCP_COMMANDS } from "./mcp";
import { PROFILE_COMMANDS } from "./profile";
import type { HandwrittenCommand } from "./types";

/**
 * Every hand-written command. Their first words (`auth`, `profile`, `mcp`) are
 * reserved, so the generator skips any operation that names one.
 */
export const HANDWRITTEN_COMMANDS: readonly HandwrittenCommand[] = [
  ...AUTH_COMMANDS,
  ...PROFILE_COMMANDS,
  ...MCP_COMMANDS,
];
