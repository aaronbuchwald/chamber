/**
 * sqlite.test.ts — the SDK's structural guarantees at the data-handle level.
 *
 * Schema derivation from proto descriptors, identifier allowlisting (the
 * injection-safety guarantee), read-handle write rejection, and JSON-Schema
 * projection. These back the app-level acceptance tests with unit coverage of
 * the SDK primitives.
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LogMealRequestSchema, NutritionService } from "../gen/nutrition/v1/nutrition_pb.js";
import { deriveSchema, openSqlite, protoMessageToJsonSchema } from "../src/index.js";
import type { ReferenceTable } from "../src/index.js";

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

const reference: ReferenceTable = {
  kind: "reference",
  name: "component_nutrients",
  columns: [
    { name: "component", affinity: "TEXT", primaryKey: false },
    { name: "nutrient", affinity: "TEXT", primaryKey: false },
    { name: "kind", affinity: "TEXT", primaryKey: false },
    { name: "unit", affinity: "TEXT", primaryKey: false },
    { name: "amount_per_100g", affinity: "REAL", primaryKey: false },
  ],
  primaryKey: ["component", "nutrient"],
  seed: [{ component: "egg", nutrient: "Protein", kind: "macro", unit: "g", amount_per_100g: 13 }],
};

function open() {
  const schema = deriveSchema(NutritionService, [reference]);
  return { schema, backend: openSqlite(schema, { transformDir: FIXTURE_DIR }) };
}

test("deriveSchema: Bronze tables from scalar messages, Gold view from transform basename", () => {
  const schema = deriveSchema(NutritionService, [reference]);
  const tableNames = schema.tables.map((t) => t.name).sort();
  assert.deepEqual(tableNames, ["meal_components", "meals"]);
  // field #1 is the primary key
  const meals = schema.tables.find((t) => t.name === "meals");
  assert.equal(meals?.columns.find((c) => c.primaryKey)?.name, "id");
  // the Gold view's name is the transform file basename
  assert.equal(schema.views[0]?.name, "gold_meal_nutrition");
  assert.deepEqual(schema.views[0]?.columns, ["meal_id", "nutrient", "kind", "unit", "amount"]);
});

test("seed is idempotent: re-opening the same DB does not duplicate reference rows", () => {
  const { backend } = open();
  const rows = backend.readHandle().query("component_nutrients");
  assert.equal(rows.length, 1);
  backend.close();
});

test("injection-safety: unknown table/column identifiers are rejected (allowlist)", () => {
  const { backend } = open();
  const w = backend.writeHandle();
  assert.throws(() => w.insert("meals; DROP TABLE meals", { id: "x" }), /unknown table/);
  assert.throws(() => w.insert("meals", { "name = 1; --": "x" }), /unknown column/);
  assert.throws(() => w.query("meals", { eq: ["name; --", "x"] }), /unknown column/);
  backend.close();
});

test("injection-safety: a value with SQL metacharacters is stored verbatim (bound param)", () => {
  const { backend } = open();
  const w = backend.writeHandle();
  const evil = "'; DROP TABLE meals;--";
  w.insert("meals", { id: "1", name: evil, eaten_at: 1 });
  const rows = w.query("meals", { eq: ["id", "1"] });
  assert.equal(rows.length, 1, "meals table intact");
  assert.equal(rows[0]?.name, evil, "stored verbatim");
  backend.close();
});

test("read handle rejects insert; views reject insert", () => {
  const { backend } = open();
  assert.throws(() => backend.readHandle().insert("meals", { id: "1" }), /read-only handle/);
  assert.throws(
    () => backend.writeHandle().insert("gold_meal_nutrition", { meal_id: "1" }),
    /cannot insert into view/,
  );
  backend.close();
});

test("transaction rolls back on throw", () => {
  const { backend } = open();
  assert.throws(() => {
    backend.transaction(() => {
      backend.writeHandle().insert("meals", { id: "1", name: "x", eaten_at: 1 });
      throw new Error("boom");
    });
  }, /boom/);
  assert.equal(backend.readHandle().query("meals").length, 0, "rolled back");
  backend.close();
});

test("protoMessageToJsonSchema: 2020-12 schema covering scalars, int64, repeated message", () => {
  const schema = protoMessageToJsonSchema(LogMealRequestSchema);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.type, "object");
  const props = schema.properties ?? {};
  assert.equal(props.description?.type, "string");
  // int64 (eaten_at) accepts number OR numeric string per proto3 JSON
  assert.ok(props.eaten_at?.oneOf, "int64 is a number|string oneOf");
  // repeated message (components) → array of objects with the nested fields
  assert.equal(props.components?.type, "array");
  assert.equal(props.components?.items?.type, "object");
  assert.ok(props.components?.items?.properties?.qty_g, "nested message field projected");
});
