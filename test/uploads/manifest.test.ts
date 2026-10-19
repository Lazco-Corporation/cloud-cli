import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliError } from "../../src/core/errors";
import { walkSiteDirectory } from "../../src/uploads/pages/directory";
import { buildManifest } from "../../src/uploads/pages/manifest";
import { parseDeployRules } from "../../src/uploads/pages/rules";
import { defaultPagesState } from "../helpers/pagesApi";

const rules = parseDeployRules(defaultPagesState().rules);
/** `中文頁` in Big5, which is not valid UTF-8. */
const BIG5_PAGE = new Uint8Array([
  0x3c, 0x70, 0x3e, 0xa4, 0xa4, 0xa4, 0xe5, 0xad, 0xb6, 0x3c, 0x2f, 0x70, 0x3e,
]);

let site: string;

beforeEach(async () => {
  site = await realpath(await mkdtemp(path.join(tmpdir(), "lazco-manifest-")));
});

afterEach(async () => {
  await rm(site, { recursive: true, force: true });
});

async function put(relative: string, content: string | Uint8Array): Promise<void> {
  const file = path.join(site, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function manifestOf() {
  const { files } = await walkSiteDirectory(site);
  return buildManifest(files, rules);
}

describe("the manifest", () => {
  test("each file carries its size and lowercase hex SHA-256", async () => {
    await put("data.bin", "abc");
    await put("empty.txt", "");
    expect(await manifestOf()).toEqual([
      {
        path: "data.bin",
        size: 3,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      },
      {
        path: "empty.txt",
        size: 0,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    ]);
  });

  test("a page in Big5 carries its exact bytes", async () => {
    await put("index.html", BIG5_PAGE);
    const [entry] = await manifestOf();
    expect(entry?.contentBase64).toBe(Buffer.from(BIG5_PAGE).toString("base64"));
    expect(Buffer.from(entry?.contentBase64 as string, "base64")).toEqual(Buffer.from(BIG5_PAGE));
    expect(entry?.sha256).toBe(new Bun.CryptoHasher("sha256").update(BIG5_PAGE).digest("hex"));
  });

  test("the extension is matched in lowercase, so INDEX.HTML carries its content", async () => {
    await put("INDEX.HTML", "<p>hi</p>");
    await put("Styles/Site.CSS", "p{}");
    const manifest = await manifestOf();
    expect(manifest.map((entry) => [entry.path, entry.contentBase64 !== undefined])).toEqual([
      ["INDEX.HTML", true],
      ["Styles/Site.CSS", true],
    ]);
  });

  test("logo.svg carries its content, and logo.png and a font carry none", async () => {
    await put("img/logo.svg", "<svg/>");
    await put("img/logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    await put("fonts/a.woff2", "woff");
    const byPath = Object.fromEntries((await manifestOf()).map((entry) => [entry.path, entry]));
    expect(byPath["img/logo.svg"]?.contentBase64).toBe(Buffer.from("<svg/>").toString("base64"));
    expect(Object.keys(byPath["img/logo.png"] ?? {}).sort()).toEqual(["path", "sha256", "size"]);
    expect(byPath["fonts/a.woff2"]?.contentBase64).toBeUndefined();
  });

  test("the content extensions come from the rules, not from the CLI", async () => {
    await put("data.json", "{}");
    const { files } = await walkSiteDirectory(site);
    const withJson = parseDeployRules({
      ...defaultPagesState().rules,
      contentExtensions: ["json"],
    });
    expect((await buildManifest(files, withJson))[0]?.contentBase64).toBe(
      Buffer.from("{}").toString("base64"),
    );
    expect((await buildManifest(files, rules))[0]?.contentBase64).toBeUndefined();
  });

  test("a file whose size changed after the walk is refused by name", async () => {
    await put("app.js", "one");
    const { files } = await walkSiteDirectory(site);
    await put("app.js", "a longer build");
    try {
      await buildManifest(files, rules);
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("CLI_INVALID_INPUT");
      expect((error as CliError).details).toEqual({ path: "app.js" });
    }
  });
});
