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
 *
 * Exercised against the generic `testkit.v1` datagram so the SDK's own tests carry
 * no domain coupling.
 */

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { clone, create, setExtension } from "@bufbuild/protobuf";
import { ServiceOptionsSchema } from "@bufbuild/protobuf/wkt";
import { Access, access as accessExt } from "@chamber/proto/chamber/v1/options_pb";
// testkit.v1 is a TEST-ONLY fixture. It is generated into @chamber/proto's gen
// tree (the single home for codegen) but NOT part of that package's public
// exports map, so production code can't import it — SDK tests reach it via this
// relative path into the gen dir instead.
import { StoreService } from "../../proto/gen/testkit/v1/store_pb.js";
import type { Operation, ReferenceTable } from "../src/index.js";
import {
  type AppDef,
  defineApp,
  deriveSchema,
  invokeOperation,
  openSqlite,
  protoToOperations,
} from "../src/index.js";
import type { Handlers, PreparedHandler } from "../src/runner.js";

/** Wrap a single op in a throwaway app so invokeOperation has a bus to emit on. */
function appFor(op: Operation): AppDef {
  return defineApp({ name: "testkit", version: "0.0.0", operations: [op] });
}

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
  seed: [],
};

function openBackend() {
  return openSqlite(deriveSchema(StoreService, [reference]), { transformDir: FIXTURE_DIR });
}

/** The two read handlers; tests only exercise place_order. */
const reads: Handlers = {
  orderTotals: (_r, { data }) => ({ totals: data.query("gold_order_totals") }),
  listOrders: (_r, { data }) => ({ orders: data.query("orders") }),
};

function placeOp(backend: ReturnType<typeof openBackend>, placeOrder: Handlers["placeOrder"]) {
  const ops = protoToOperations(StoreService, backend, { placeOrder, ...reads });
  const op = ops.find((o) => o.name === "place_order");
  assert.ok(op);
  const parsed = op.validate({ label: "x" });
  assert.ok(parsed.ok);
  return { app: appFor(op), op, args: parsed.value };
}

test("sync handler: runs inside the per-write transaction and commits (v0 shape unchanged)", () => {
  const backend = openBackend();
  try {
    const { app, op, args } = placeOp(backend, (_req, { data }) => {
      data.insert("orders", { id: "o1", label: "sync", placed_at: 1 });
      return { order_id: "o1" };
    });
    const result = invokeOperation(app, op, args);
    assert.equal((result as { order_id: string }).order_id, "o1");
    assert.equal(backend.readHandle().query("orders").length, 1);
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
        return { placed_at: 42 };
      },
      commit(prepared, _req, { data }) {
        order.push("commit");
        const { placed_at } = prepared as { placed_at: number };
        data.insert("orders", { id: "o2", label: "async", placed_at });
        return { order_id: "o2" };
      },
    };
    const { app, op, args } = placeOp(backend, handler);
    const result = await invokeOperation(app, op, args);
    assert.equal((result as { order_id: string }).order_id, "o2");
    // prepare fully completes before commit begins — no transaction is held across the await.
    assert.deepEqual(order, ["prepare:start", "prepare:end", "commit"]);
    const rows = backend.readHandle().query("orders");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.placed_at, 42, "prepared value flowed into the committed write");
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
        data.insert("orders", { id: "doomed", label: "doomed", placed_at: 1 });
        data.insert("order_lines", { id: "l1", order_id: "doomed", sku: "sku-1", qty: 1 });
        throw new Error("boom in commit");
      },
    };
    const { app, op, args } = placeOp(backend, handler);
    await assert.rejects(
      () => invokeOperation(app, op, args) as Promise<unknown>,
      /boom in commit/,
    );
    assert.equal(backend.readHandle().query("orders").length, 0, "orders rolled back");
    assert.equal(backend.readHandle().query("order_lines").length, 0, "order_lines rolled back");
  } finally {
    backend.close();
  }
});

test("access guard: a write on a read-only dataset is rejected before prepare runs", () => {
  const svc = StoreService;
  const baseOptions = svc.proto.options ?? create(ServiceOptionsSchema);
  const opts = clone(ServiceOptionsSchema, baseOptions);
  setExtension(opts, accessExt, Access.READ);
  const patchedProto = new Proxy(svc.proto, {
    get: (t, p, r) => (p === "options" ? opts : Reflect.get(t, p, r)),
  });
  const readOnly = new Proxy(svc, {
    get: (t, p, r) => (p === "proto" ? patchedProto : Reflect.get(t, p, r)),
  }) as typeof StoreService;

  const backend = openBackend();
  try {
    let prepared = false;
    const ops = protoToOperations(readOnly, backend, {
      placeOrder: {
        async prepare() {
          prepared = true;
          return null;
        },
        commit: () => ({ order_id: "x" }),
      },
      ...reads,
    });
    const op = ops.find((o) => o.name === "place_order");
    assert.ok(op);
    const parsed = op.validate({ label: "x" });
    assert.ok(parsed.ok);
    assert.throws(
      () => invokeOperation(appFor(op), op, parsed.value),
      /forbidden: read-only dataset/,
    );
    assert.equal(prepared, false, "prepare never ran — guard fires first");
  } finally {
    backend.close();
  }
});
