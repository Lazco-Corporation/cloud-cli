import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SpecSource } from "../core/spec/loader";
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
    "A local MCP server for an MCP client to start. It uses the credential of this run, as every command does. Without --allow-writes it offers read tools only. With it, write tools and the destructive tools that need a confirmation are added, unless the token's scope is read. Nothing but MCP is written to stdout.",
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
      credential,
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

export const MCP_COMMANDS: readonly HandwrittenCommand[] = [serve];
