import { describe, expect, test } from "bun:test";
import { KNOWN_UPLOADERS } from "../../src/core/generate/annotation";
import { generateSurface, type Operation } from "../../src/core/generate/operations";
import { createAjv } from "../../src/core/request/ajv";
import { prepareRequest } from "../../src/core/request/build";
import { InputValidator } from "../../src/core/request/validate";
import { selectTools } from "../../src/mcp/tools";
import { describeEntry } from "../../src/shell/describe";
import { operationEntry } from "../../src/shell/entries";
import { buildInput } from "../../src/shell/input";
import { UPLOADERS } from "../../src/uploads/registry";
import { loadFixture } from "../helpers/fixtures";

const ajv = createAjv();
const facts = (scope: string) => ({
  organization: { id: "org-1", name: "Org" },
  scope,
  features: { pages: true },
});

function deployOperation(): Operation {
  const { operations } = generateSurface(loadFixture("pages"), ajv);
  const operation = operations.find(
    (candidate) => candidate.command.join(" ") === "labs pages deployments create",
  );
  if (!operation) {
    throw new Error("no deploy command");
  }
  return operation;
}

describe("the uploader pages-deployment", () => {
  test("every known uploader has its code, and no code is unknown", () => {
    expect([...UPLOADERS.keys()].sort()).toEqual([...KNOWN_UPLOADERS.keys()].sort());
    expect(KNOWN_UPLOADERS.has("pages-deployment")).toBe(true);
  });

  test("the command takes the site and directory in place of the manifest body", () => {
    const operation = deployOperation();
    expect(operation.body).toEqual({ mode: "upload", uploader: "pages-deployment" });
    expect(operation.toolName).toBe("labs_pages_create_deployment");
    expect(operation.kind).toBe("write");
    expect(operation.feature).toBe("pages");
    expect(operation.positionals).toEqual(["id", "directory"]);
    expect(Object.keys(operation.inputSchema.properties as object).sort()).toEqual([
      "directory",
      "id",
    ]);
    expect(operation.inputSchema.required).toEqual(["id", "directory"]);
    expect(operation.inputSchema.additionalProperties).toBe(false);
    expect(JSON.stringify(operation.inputSchema)).not.toContain("sha256");
  });

  test("--describe shows the uploader's inputs and no files manifest", () => {
    const described = describeEntry(operationEntry(deployOperation()));
    expect(described.upload).toBe("pages-deployment");
    expect(described.positionals).toEqual(["id", "directory"]);
    expect(described.flags).toEqual({});
    expect(Object.keys((described.inputSchema as { properties: object }).properties)).toEqual([
      "id",
      "directory",
    ]);
  });

  test("the directory is the second positional, and --json takes it too", () => {
    const entry = operationEntry(deployOperation());
    expect(
      buildInput({
        schema: entry.inputSchema,
        positionals: entry.positionals,
        tokens: ["site-1", "./dist"],
        payload: undefined,
      }),
    ).toEqual({ id: "site-1", directory: "./dist" });
    expect(
      buildInput({
        schema: entry.inputSchema,
        positionals: entry.positionals,
        tokens: [],
        payload: { id: "site-1", directory: "/srv/dist" },
      }),
    ).toEqual({ id: "site-1", directory: "/srv/dist" });
  });

  test("the request of the input names the deploy start and carries no body", () => {
    const request = prepareRequest(
      deployOperation(),
      { id: "site-1", directory: "dist" },
      { apiUrl: "https://api.example.test/v1", validator: new InputValidator(ajv) },
    );
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/labs/pages/sites/site-1/deployments");
    expect(request.body).toBeUndefined();
    expect(() =>
      prepareRequest(
        deployOperation(),
        { id: "site-1", directory: "dist", files: [] },
        { apiUrl: "https://api.example.test/v1", validator: new InputValidator(ajv) },
      ),
    ).toThrow();
  });

  test("the tool is offered only with --allow-writes on a profile that can write", () => {
    const { operations } = generateSurface(loadFixture("pages"), ajv);
    const named = (allowWrites: boolean, scope: string) =>
      selectTools(operations, { allowWrites, facts: facts(scope) }).tools.map((tool) => tool.name);
    expect(named(false, "read_write")).not.toContain("labs_pages_create_deployment");
    expect(named(true, "read")).not.toContain("labs_pages_create_deployment");
    expect(named(true, "read_write")).toContain("labs_pages_create_deployment");
    expect(named(true, "full")).toContain("labs_pages_create_deployment");
    const tool = selectTools(operations, {
      allowWrites: true,
      facts: facts("read_write"),
    }).tools.find((candidate) => candidate.name === "labs_pages_create_deployment");
    expect(Object.keys(tool?.inputSchema.properties as object)).toEqual(["id", "directory"]);
    expect(tool?.description).toContain("absolute path");
    expect(tool?.description).toContain("anyone on the internet");
  });

  test("an upload this version does not know registers no command and no tool", () => {
    const { operations, skipped } = generateSurface(loadFixture("skips"), ajv);
    expect(skipped.find((skip) => skip.operationId === "labs.pages.deployments.create")).toEqual(
      expect.objectContaining({ reason: "no-uploader" }),
    );
    expect(operations.some((operation) => operation.command[0] === "labs")).toBe(false);
    const tools = selectTools(operations, { allowWrites: true, facts: facts("read_write") }).tools;
    expect(tools.map((tool) => tool.name)).not.toContain("labs_pages_create_deployment");
  });

  test("an uploader input that clashes with a parameter skips the operation", () => {
    const document = loadFixture("pages");
    const start = document.paths["/v1/labs/pages/sites/{id}/deployments"]?.post;
    if (!start?.parameters) throw new Error("fixture changed");
    start.parameters.push({ name: "directory", in: "query", schema: { type: "string" } });
    const { skipped } = generateSurface(document, ajv);
    expect(skipped.map((skip) => [skip.operationId, skip.reason])).toEqual([
      ["labs.pages.deployments.create", "unsupported-parameter"],
    ]);
  });
});
