/**
 * runner.test.ts — the runner's handler dispatch, including async two-phase handlers.
 *
 * Covers the change that lets a write handler do NETWORK work outside the atomic
 * transaction:
 *   1. A plain SYNC handler still runs inside the per-write transaction (v0 shape).
 *   2. A two-phase {@link PreparedHandler} runs `prepare` (async, may be network)
 *      OUTSIDE the transaction, then `commit` (sync DB writes) INSIDE it — and the
 *      prepared value flows from prepare → commit.
 *   3. The network/prepare phase runs BEFORE the transaction opens (asserted via
 *      ordering), so a transaction is never held open across an await.
 *   4. A throw in `commit` rolls back the whole write (atomicity preserved).
 *   5. The single-point access guard still rejects writes on a read-only dataset,
 *      before any prepare runs.
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { clone, create, setExtension } from "@bufbuild/protobuf";
import { ServiceOptionsSchema } from "@bufbuild/protobuf/wkt";
import { Access, access as accessExt } from "../gen/chamber/v1/options_pb.js";
import { NutritionService } from "../gen/nutrition/v1/nutrition_pb.js";
import type { ReferenceTable } from "../src/index.js";
import { deriveSchema, invokeOperation, openSqlite, protoToOperations } from "../src/index.js";
import type { Handlers, PreparedHandler } from "../src/runner.js";

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
  seed: [],
};

function openBackend() {
  return openSqlite(deriveSchema(NutritionService, [reference]), { transformDir: FIXTURE_DIR });
}

/** The two read handlers nutrition needs; tests only exercise log_meal. */
const reads: Handlers = {
  nutritionFor: (_r, { data }) => ({ nutrition: data.query("gold_meal_nutrition") }),
  listMeals: (_r, { data }) => ({ meals: data.query("meals") }),
};

function logOp(backend: ReturnType<typeof openBackend>, logMeal: Handlers["logMeal"]) {
  const ops = protoToOperations(NutritionService, backend, { logMeal, ...reads });
  const op = ops.find((o) => o.name === "log_meal");
  assert.ok(op);
  const parsed = op.validate({ description: "x" });
  assert.ok(parsed.ok);
  return { op, args: parsed.value };
}

test("sync handler: runs inside the per-write transaction and commits (v0 shape unchanged)", () => {
  const backend = openBackend();
  try {
    const { op, args } = logOp(backend, (_req, { data }) => {
      data.insert("meals", { id: "m1", name: "sync", eaten_at: 1 });
      return { meal_id: "m1" };
    });
    const result = invokeOperation(op, args);
    assert.equal((result as { meal_id: string }).meal_id, "m1");
    assert.equal(backend.readHandle().query("meals").length, 1);
  } finally {
    backend.close();
  }
});

test("async two-phase handler: prepare (outside txn) resolves, commit (inside txn) writes", async () => {
  const backend = openBackend();
  try {
    const order: string[] = [];
    const handler: PreparedHandler = {
      async prepare() {
        order.push("prepare:start");
        await Promise.resolve(); // simulate awaiting the network
        order.push("prepare:end");
        return { eaten_at: 42 };
      },
      commit(prepared, _req, { data }) {
        order.push("commit");
        const { eaten_at } = prepared as { eaten_at: number };
        data.insert("meals", { id: "m2", name: "async", eaten_at });
        return { meal_id: "m2" };
      },
    };
    const { op, args } = logOp(backend, handler);
    const result = await invokeOperation(op, args);
    assert.equal((result as { meal_id: string }).meal_id, "m2");
    // prepare fully completes before commit begins — no transaction is held across the await.
    assert.deepEqual(order, ["prepare:start", "prepare:end", "commit"]);
    const rows = backend.readHandle().query("meals");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.eaten_at, 42, "prepared value flowed into the committed write");
  } finally {
    backend.close();
  }
});

test("atomicity: a throw in commit rolls back the whole write (after a successful async prepare)", async () => {
  const backend = openBackend();
  try {
    const handler: PreparedHandler = {
      async prepare() {
        await Promise.resolve();
        return null;
      },
      commit(_prepared, _req, { data }) {
        data.insert("meals", { id: "doomed", name: "doomed", eaten_at: 1 });
        data.insert("meal_components", {
          id: "c1",
          meal_id: "doomed",
          component: "egg",
          qty_g: 100,
        });
        throw new Error("boom in commit");
      },
    };
    const { op, args } = logOp(backend, handler);
    await assert.rejects(() => invokeOperation(op, args) as Promise<unknown>, /boom in commit/);
    assert.equal(backend.readHandle().query("meals").length, 0, "meals rolled back");
    assert.equal(backend.readHandle().query("meal_components").length, 0, "components rolled back");
  } finally {
    backend.close();
  }
});

test("access guard: a write on a read-only dataset is rejected before prepare runs", () => {
  const svc = NutritionService;
  const baseOptions = svc.proto.options ?? create(ServiceOptionsSchema);
  const opts = clone(ServiceOptionsSchema, baseOptions);
  setExtension(opts, accessExt, Access.READ);
  const patchedProto = new Proxy(svc.proto, {
    get: (t, p, r) => (p === "options" ? opts : Reflect.get(t, p, r)),
  });
  const readOnly = new Proxy(svc, {
    get: (t, p, r) => (p === "proto" ? patchedProto : Reflect.get(t, p, r)),
  }) as typeof NutritionService;

  const backend = openBackend();
  try {
    let prepared = false;
    const ops = protoToOperations(readOnly, backend, {
      logMeal: {
        async prepare() {
          prepared = true;
          return null;
        },
        commit: () => ({ meal_id: "x" }),
      },
      ...reads,
    });
    const op = ops.find((o) => o.name === "log_meal");
    assert.ok(op);
    const parsed = op.validate({ description: "x" });
    assert.ok(parsed.ok);
    assert.throws(() => invokeOperation(op, parsed.value), /forbidden: read-only dataset/);
    assert.equal(prepared, false, "prepare never ran — guard fires first");
  } finally {
    backend.close();
  }
});
