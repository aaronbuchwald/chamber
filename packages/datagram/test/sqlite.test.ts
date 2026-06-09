/**
 * sqlite.test.ts — the SDK's structural guarantees at the data-handle level.
 *
 * Schema derivation from proto descriptors, identifier allowlisting (the
 * injection-safety guarantee), read-handle write rejection, and JSON-Schema
 * projection. These back the app-level acceptance tests with unit coverage of
 * the SDK primitives — exercised against the generic `testkit.v1` datagram so the
 * SDK stays free of any real domain.
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// testkit.v1 is a TEST-ONLY fixture: generated in @chamber/proto's gen tree but
// excluded from its public exports, so it's reached only via this relative path.
import { PlaceOrderRequestSchema, StoreService } from "../../proto/gen/testkit/v1/store_pb.js";
import { deriveSchema, openSqlite, protoMessageToJsonSchema } from "../src/index.js";
import type { ReferenceTable } from "../src/index.js";

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

const reference: ReferenceTable = {
  kind: "reference",
  name: "sku_metrics",
  columns: [
    { name: "sku", affinity: "TEXT", primaryKey: false },
    { name: "metric", affinity: "TEXT", primaryKey: false },
    { name: "unit", affinity: "TEXT", primaryKey: false },
    { name: "amount_per_unit", affinity: "REAL", primaryKey: false },
  ],
  primaryKey: ["sku", "metric"],
  seed: [{ sku: "sku-1", metric: "Weight", unit: "kg", amount_per_unit: 2 }],
};

function open() {
  const schema = deriveSchema(StoreService, [reference]);
  return { schema, backend: openSqlite(schema, { transformDir: FIXTURE_DIR }) };
}

test("deriveSchema: Bronze tables from scalar messages, Gold view from transform basename", () => {
  const schema = deriveSchema(StoreService, [reference]);
  const tableNames = schema.tables.map((t) => t.name).sort();
  assert.deepEqual(tableNames, ["order_lines", "orders"]);
  // field #1 is the primary key
  const orders = schema.tables.find((t) => t.name === "orders");
  assert.equal(orders?.columns.find((c) => c.primaryKey)?.name, "id");
  // the Gold view's name is the transform file basename
  assert.equal(schema.views[0]?.name, "gold_order_totals");
  assert.deepEqual(schema.views[0]?.columns, ["order_id", "metric", "unit", "amount"]);
});

test("seed is idempotent: re-opening the same DB does not duplicate reference rows", () => {
  const { backend } = open();
  const rows = backend.readHandle().query("sku_metrics");
  assert.equal(rows.length, 1);
  backend.close();
});

test("injection-safety: unknown table/column identifiers are rejected (allowlist)", () => {
  const { backend } = open();
  const w = backend.writeHandle();
  assert.throws(() => w.insert("orders; DROP TABLE orders", { id: "x" }), /unknown table/);
  assert.throws(() => w.insert("orders", { "label = 1; --": "x" }), /unknown column/);
  assert.throws(() => w.query("orders", { eq: ["label; --", "x"] }), /unknown column/);
  backend.close();
});

test("injection-safety: a value with SQL metacharacters is stored verbatim (bound param)", () => {
  const { backend } = open();
  const w = backend.writeHandle();
  const evil = "'; DROP TABLE orders;--";
  w.insert("orders", { id: "1", label: evil, placed_at: 1 });
  const rows = w.query("orders", { eq: ["id", "1"] });
  assert.equal(rows.length, 1, "orders table intact");
  assert.equal(rows[0]?.label, evil, "stored verbatim");
  backend.close();
});

test("read handle rejects insert; views reject insert", () => {
  const { backend } = open();
  assert.throws(() => backend.readHandle().insert("orders", { id: "1" }), /read-only handle/);
  assert.throws(
    () => backend.writeHandle().insert("gold_order_totals", { order_id: "1" }),
    /cannot insert into view/,
  );
  backend.close();
});

test("transaction rolls back on throw", () => {
  const { backend } = open();
  assert.throws(() => {
    backend.transaction(() => {
      backend.writeHandle().insert("orders", { id: "1", label: "x", placed_at: 1 });
      throw new Error("boom");
    });
  }, /boom/);
  assert.equal(backend.readHandle().query("orders").length, 0, "rolled back");
  backend.close();
});

test("protoMessageToJsonSchema: 2020-12 schema covering scalars, int64, repeated message", () => {
  const schema = protoMessageToJsonSchema(PlaceOrderRequestSchema);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.type, "object");
  const props = schema.properties ?? {};
  assert.equal(props.label?.type, "string");
  // int64 (placed_at) accepts number OR numeric string per proto3 JSON
  assert.ok(props.placed_at?.oneOf, "int64 is a number|string oneOf");
  // repeated message (lines) → array of objects with the nested fields
  assert.equal(props.lines?.type, "array");
  assert.equal(props.lines?.items?.type, "object");
  assert.ok(props.lines?.items?.properties?.qty, "nested message field projected");
});
