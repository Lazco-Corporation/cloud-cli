import { readFile } from "node:fs/promises";
import { z } from "zod";
import { CliError } from "../core/errors";
import { ssoRecordSchema } from "../credentials/ssoRecord";
import { writeFileAtomic } from "./atomicFile";

/** A profile name starts the keychain account, so it stays short and plain. */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A keychain account: the profile name, `@`, and 16 random hexadecimal
 * characters of one login, so two config files with one profile name never
 * share an entry.
 */
export const KEYCHAIN_ACCOUNT = new RegExp(`${PROFILE_NAME.source.slice(0, -1)}@[0-9a-f]{16}$`);

export const DEFAULT_PROFILE = "default";

const profileNameSchema = z.string().regex(PROFILE_NAME, "is not a valid profile name");

/**
 * Where a profile's credential is: a keychain account, or the file itself.
 * In the file, a pasted token is `token` and an SSO sign-in is `sso`.
 */
const credentialSchema = z.discriminatedUnion("store", [
  z.looseObject({
    store: z.literal("keychain"),
    account: z.string().regex(KEYCHAIN_ACCOUNT, "is not a valid keychain account"),
  }),
  z.looseObject({
    store: z.literal("file"),
    token: z.string().min(1).optional(),
    sso: ssoRecordSchema.optional(),
  }),
]);

/** How a profile signed in: with a pasted API token, or with the Lazco account (SSO). */
export const SIGN_IN_METHODS = ["token", "sso"] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

const profileSchema = z
  .looseObject({
    apiUrl: z.url(),
    organization: z.looseObject({ id: z.string().min(1), name: z.string() }),
    method: z.enum(SIGN_IN_METHODS),
    credential: credentialSchema,
  })
  .superRefine((profile, context) => {
    const credential = profile.credential;
    if (credential.store !== "file") {
      return;
    }
    const holds = profile.method === "token" ? "token" : "sso";
    const other = profile.method === "token" ? "sso" : "token";
    if (credential[holds] === undefined || credential[other] !== undefined) {
      context.addIssue({
        code: "custom",
        message: `must hold ${holds} only, for the method ${profile.method}`,
        path: ["credential"],
      });
    }
  });

const configSchema = z
  .looseObject({
    version: z.literal(1),
    currentProfile: profileNameSchema.optional(),
    profiles: z.record(profileNameSchema, profileSchema),
  })
  .refine(
    (config) =>
      config.currentProfile === undefined || Object.hasOwn(config.profiles, config.currentProfile),
    { message: "names a profile that does not exist", path: ["currentProfile"] },
  )
  .superRefine((config, context) => {
    for (const [name, profile] of Object.entries(config.profiles)) {
      if (
        profile.credential.store === "keychain" &&
        !profile.credential.account.startsWith(`${name}@`)
      ) {
        context.addIssue({
          code: "custom",
          message: `names the keychain account of another profile`,
          path: ["profiles", name, "credential", "account"],
        });
      }
    }
  });

export type StoredCredential = z.infer<typeof credentialSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type Config = z.infer<typeof configSchema>;

/**
 * The profile of a name, or `undefined`. Reads own properties only, so a name
 * such as `constructor` never finds a built-in of the object.
 */
export function profileOf(config: Config, name: string): Profile | undefined {
  return Object.hasOwn(config.profiles, name) ? config.profiles[name] : undefined;
}

export function emptyConfig(): Config {
  return { version: 1, profiles: {} };
}

function brokenFile(path: string, problem: string): CliError {
  return new CliError("CLI_INVALID_INPUT", `${path} is not a valid lazco config file: ${problem}`, [
    { field: path, message: problem },
  ]);
}

/** The config file, or an empty config when there is none. A broken file is `CLI_INVALID_INPUT` naming it. */
export async function readConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyConfig();
    }
    throw brokenFile(path, (error as Error).message);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw brokenFile(path, "is not valid JSON");
  }
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")} ` : "";
    throw brokenFile(path, `${where}${issue?.message ?? "does not match the schema"}`);
  }
  return parsed.data;
}

/** Writes the whole file atomically with mode 0600, because a file-store profile holds its token. */
export async function writeConfig(path: string, config: Config): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(configSchema.parse(config), null, 2)}\n`, 0o600);
}

/** Throws `CLI_INVALID_INPUT` for a name that cannot be a profile. */
export function checkProfileName(name: string, field: string): string {
  if (!PROFILE_NAME.test(name)) {
    throw new CliError(
      "CLI_INVALID_INPUT",
      `${field} must be 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or digit`,
      [{ field, message: "is not a valid profile name" }],
    );
  }
  return name;
}
