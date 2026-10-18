import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readConfig } from "../config/configFile";
import { CliError } from "../core/errors";
import { SpecSource } from "../core/spec/loader";
import { installClient, MCP_CLIENTS, type McpClient, resolveLauncher } from "../mcp/install";
import { McpSession } from "../mcp/server";
import { writeNotice } from "../shell/output";
import type { HandwrittenCommand } from "./types";

/** A client's self-given name as `User-Agent` text: no control or separator character, 64 at most. */
function userAgentToken(text: string): string {
  return text.replace(/[^A-Za-z0-9._\-/ ]/g, "").slice(0, 64);
}

const serve: HandwrittenCommand = {
  command: ["mcp"],
  summary: "Serve the API's operations as MCP tools on stdio",
  description:
    "A local MCP server for an MCP client to start. It uses the credential of this run, as every command does, and refreshes an SSO sign-in as it goes. Without --allow-writes it offers read tools only. With it, write tools and the destructive tools that need a confirmation are added, unless the token's scope is read. Nothing but MCP is written to stdout.",
  kind: "read",
  positionals: [],
  inputSchema: {
    type: "object",
    properties: {
      allowWrites: {
        type: "boolean",
        description: "Add the write tools, and the destructive tools that need a confirmation",
      },
    },
    additionalProperties: false,
  },
  async run(input, context) {
    const session = await context.session();
    const credential = await context.credential();
    let clientName = "";
    const userAgent = () =>
      `lazco-cli/${context.version} (mcp${clientName ? `; ${clientName}` : ""})`;
    const warn = (message: string) => writeNotice(context.io, message);
    const mcp = await McpSession.start({
      version: context.version,
      allowWrites: input.allowWrites === true,
      secrets: () => credential.secrets(),
      client: context.client(session.apiUrl, credential, userAgent),
      specSource: new SpecSource({
        client: context.client(session.apiUrl, undefined, userAgent),
        cacheDirectory: context.cacheDirectory,
        clock: context.clock,
        warn: (message) => warn(`warning: ${message}`),
      }),
      ajv: context.ajv,
      validator: context.validator,
      clock: context.clock,
      warn,
      onClient: (client) => {
        clientName = userAgentToken(`${client.name}/${client.version}`);
      },
    });
    // The shell's streams are the process's own when an MCP client starts lazco.
    const stdin = context.io.stdin as Readable;
    const transport = new StdioServerTransport(stdin, context.io.stdout as unknown as Writable);
    stdin.once("end", () => {
      void transport.close();
    });
    await mcp.connect(transport);
    await mcp.closed;
    return { silent: true };
  },
};

const install: HandwrittenCommand = {
  command: ["mcp", "install"],
  summary: "Add lazco to an MCP client's configuration",
  description:
    "Adds or replaces the server entry lazco in the user-level configuration of one client. The entry holds the command and its arguments only, never a credential: the server reads the credential of its profile when the client starts it. --profile, --api-url and --allow-writes are written into the entry's arguments. --dry-run prints the entry and the file and changes nothing.",
  kind: "write",
  positionals: [],
  inputSchema: {
    type: "object",
    required: ["client"],
    properties: {
      client: { type: "string", enum: [...MCP_CLIENTS], description: "The MCP client" },
      allowWrites: {
        type: "boolean",
        description: "Start the server with --allow-writes",
      },
    },
    additionalProperties: false,
  },
  async run(input, context) {
    const serverArgs: string[] = [];
    if (context.flags.profile !== undefined) {
      const config = await readConfig(context.configPath);
      if (!Object.hasOwn(config.profiles, context.flags.profile)) {
        throw new CliError(
          "CLI_INVALID_INPUT",
          `No profile is named ${context.flags.profile}: sign in first with lazco auth login --profile ${context.flags.profile}`,
          [{ field: "profile", message: "names no profile" }],
        );
      }
      serverArgs.push("--profile", context.flags.profile);
    }
    if (context.flags.apiUrl !== undefined) {
      serverArgs.push("--api-url", context.flags.apiUrl);
    }
    if (input.allowWrites === true) {
      serverArgs.push("--allow-writes");
    }
    const launcher = await resolveLauncher({
      paths: context.paths,
      execPath: process.execPath,
      version: context.version,
      serverArgs,
    });
    return {
      record: await installClient({
        client: input.client as McpClient,
        paths: context.paths,
        launcher,
        dryRun: context.flags.dryRun,
      }),
    };
  },
};

export const MCP_COMMANDS: readonly HandwrittenCommand[] = [serve, install];
