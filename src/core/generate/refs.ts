import type { JsonSchema, OpenApiDocument } from "../spec/types";

/** A `$ref` that is not local, or names nothing in the document. */
export class UnresolvableReferenceError extends Error {
  readonly reference: string;

  constructor(reference: string) {
    super(`cannot resolve $ref ${reference}`);
    this.name = "UnresolvableReferenceError";
    this.reference = reference;
  }
}

/** The value a local JSON pointer such as `#/components/schemas/Server` names. */
export function lookupPointer(document: OpenApiDocument, reference: string): unknown {
  if (!reference.startsWith("#/")) {
    throw new UnresolvableReferenceError(reference);
  }
  let node: unknown = document;
  for (const rawSegment of reference.slice(2).split("/")) {
    const segment = decodeURIComponent(rawSegment).replaceAll("~1", "/").replaceAll("~0", "~");
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, segment)) {
      throw new UnresolvableReferenceError(reference);
    }
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * Builds one self-contained schema from a part of the spec. Every local `$ref`
 * is copied in place, except one that refers back to a schema it is already
 * inside: a cycle cannot be copied out, so that schema goes to `$defs` and the
 * reference points there.
 */
export function resolveReferences(
  document: OpenApiDocument,
  schema: JsonSchema,
): { schema: JsonSchema; definitions: Record<string, JsonSchema> } {
  const definitionNames = new Map<string, string>();
  const definitions: Record<string, JsonSchema> = {};

  const definitionName = (reference: string): string => {
    const existing = definitionNames.get(reference);
    if (existing) {
      return existing;
    }
    const base = reference.split("/").pop() || "schema";
    let name = base;
    for (let suffix = 2; [...definitionNames.values()].includes(name); suffix += 1) {
      name = `${base}${suffix}`;
    }
    definitionNames.set(reference, name);
    return name;
  };

  const resolve = (node: unknown, stack: readonly string[]): unknown => {
    if (Array.isArray(node)) {
      return node.map((child) => resolve(child, stack));
    }
    if (node === null || typeof node !== "object") {
      return node;
    }
    const { $ref: reference, ...siblings } = node as Record<string, unknown>;
    const resolvedSiblings = Object.fromEntries(
      Object.entries(siblings).map(([key, child]) => [key, resolve(child, stack)]),
    );
    if (typeof reference !== "string") {
      return resolvedSiblings;
    }
    if (stack.includes(reference)) {
      return { ...resolvedSiblings, $ref: `#/$defs/${definitionName(reference)}` };
    }
    const target = resolve(lookupPointer(document, reference), [...stack, reference]);
    if (target === null || typeof target !== "object" || Array.isArray(target)) {
      throw new UnresolvableReferenceError(reference);
    }
    return { ...target, ...resolvedSiblings };
  };

  const resolved = resolve(schema, []) as JsonSchema;
  const done = new Set<string>();
  for (let pending = [...definitionNames.keys()]; pending.length > 0; ) {
    for (const reference of pending) {
      done.add(reference);
      definitions[definitionName(reference)] = resolve(lookupPointer(document, reference), [
        reference,
      ]) as JsonSchema;
    }
    pending = [...definitionNames.keys()].filter((reference) => !done.has(reference));
  }
  return { schema: resolved, definitions };
}
