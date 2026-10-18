import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/**
 * An Ajv for the JSON Schema 2020-12 dialect of OpenAPI 3.1. `strict: false`
 * lets OpenAPI's own keywords, such as `example` or a custom `error`, pass as
 * annotations instead of failing the compile. An unknown `format` is ignored without
 * a log line, because stderr belongs to the command.
 */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
  addFormats(ajv);
  return ajv;
}
