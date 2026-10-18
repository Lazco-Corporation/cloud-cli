import { readConfig, updateConfig } from "../config/configFile";
import { CliError } from "../core/errors";
import type { HandwrittenCommand } from "./types";

const list: HandwrittenCommand = {
  command: ["profile", "list"],
  summary: "List the profiles",
  description:
    "One line per profile with its name, API URL, organization, sign-in method, store and whether it is current. Never its credential.",
  kind: "read",
  positionals: [],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async run(_input, context) {
    const config = await readConfig(context.configPath);
    return {
      list: Object.entries(config.profiles)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, profile]) => ({
          name,
          apiUrl: profile.apiUrl,
          organization: { id: profile.organization.id, name: profile.organization.name },
          method: profile.method,
          store: profile.credential.store,
          current: config.currentProfile === name,
        })),
    };
  },
};

const use: HandwrittenCommand = {
  command: ["profile", "use"],
  summary: "Make a profile the current one",
  kind: "write",
  positionals: ["name"],
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string", description: "The profile name" } },
    additionalProperties: false,
  },
  async run(input, context) {
    const name = input.name as string;
    await updateConfig(context.configPath, (config) => {
      if (!Object.hasOwn(config.profiles, name)) {
        throw new CliError(
          "CLI_INVALID_INPUT",
          `No profile is named ${name}: run lazco profile list`,
          [{ field: "name", message: "names no profile" }],
        );
      }
      config.currentProfile = name;
    });
    return { record: { profile: name, current: true } };
  },
};

export const PROFILE_COMMANDS: readonly HandwrittenCommand[] = [list, use];
