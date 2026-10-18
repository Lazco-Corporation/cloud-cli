/** The parts of an OpenAPI 3.1 document that the core reads. */

export type JsonSchema = { [keyword: string]: unknown };

export type OpenApiParameter = {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
};

export type OpenApiMediaType = { schema?: JsonSchema };

export type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<OpenApiParameter | { $ref: string }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, OpenApiMediaType>;
  };
  "x-lazco"?: unknown;
};

export const HTTP_METHODS = ["get", "put", "post", "delete", "patch"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type OpenApiPathItem = Partial<Record<HttpMethod, OpenApiOperation>> & {
  parameters?: Array<OpenApiParameter | { $ref: string }>;
};

export type OpenApiDocument = {
  openapi: string;
  info?: { title?: string; version?: string };
  paths: Record<string, OpenApiPathItem>;
  components?: Record<string, Record<string, unknown>>;
};

/** True when a value has the shape of an OpenAPI 3.1 document the core can read. */
export function isOpenApiDocument(value: unknown): value is OpenApiDocument {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const document = value as { openapi?: unknown; paths?: unknown };
  return (
    typeof document.openapi === "string" &&
    document.openapi.startsWith("3.1") &&
    document.paths !== null &&
    typeof document.paths === "object"
  );
}
