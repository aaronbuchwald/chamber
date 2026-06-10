/**
 * jsonschema.ts — a tiny proto-message → JSON-Schema (2020-12) projection.
 *
 * Used for the MCP tool `inputSchema` and the OpenAPI request body. Deliberately
 * minimal: it covers exactly the proto shapes the nutrition datagram uses —
 * string, double/float → number, the 64-bit/32-bit ints + bool → number, a
 * `repeated` field → array, and a nested message → object. proto3 JSON renders
 * 64-bit ints as strings, so int64 inputs accept either a number or a numeric
 * string. proto3 scalar fields are all optional on the wire, so nothing is
 * marked `required` (the handler/`fromJson` applies proto defaults).
 */

import { type DescField, type DescMessage, ScalarType } from "@bufbuild/protobuf";

/** A JSON-Schema node (loose by design — this is a projection, not a validator). */
export type JsonSchema = {
  $schema?: string;
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  description?: string;
  // int64 fields accept number OR numeric-string per proto3 JSON.
  oneOf?: JsonSchema[];
  additionalProperties?: boolean;
};

function scalarSchema(scalar: ScalarType): JsonSchema {
  switch (scalar) {
    case ScalarType.STRING:
    case ScalarType.BYTES:
      return { type: "string" };
    case ScalarType.BOOL:
      return { type: "boolean" };
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
    case ScalarType.INT32:
    case ScalarType.UINT32:
    case ScalarType.SINT32:
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
      return { type: "number" };
    // proto3 JSON encodes 64-bit ints as strings; accept either form.
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.SINT64:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
      return { oneOf: [{ type: "number" }, { type: "string" }] };
    default:
      return { type: "string" };
  }
}

function fieldSchema(field: DescField): JsonSchema {
  if (field.fieldKind === "list") {
    const items: JsonSchema =
      field.listKind === "message" && field.message
        ? protoMessageToJsonSchema(field.message, false)
        : scalarSchema(field.scalar ?? ScalarType.STRING);
    return { type: "array", items };
  }
  if (field.fieldKind === "message") {
    return field.message ? protoMessageToJsonSchema(field.message, false) : { type: "object" };
  }
  return scalarSchema(field.scalar ?? ScalarType.STRING);
}

/**
 * Project a proto message descriptor to a JSON-Schema object. The top-level call
 * stamps the 2020-12 `$schema`; nested message objects omit it.
 */
export function protoMessageToJsonSchema(msg: DescMessage, top = true): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const field of msg.fields) properties[field.name] = fieldSchema(field);
  const schema: JsonSchema = { type: "object", properties };
  if (top) schema.$schema = "https://json-schema.org/draft/2020-12/schema";
  return schema;
}
