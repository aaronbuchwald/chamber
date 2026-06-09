/**
 * acceptance.test.ts — the v0 plan §7 acceptance bar as automated tests.
 *
 * 1. Injection-safety   — a meal named with SQL round-trips as a bound param.
 * 2. Atomicity          — a handler that throws mid-write leaves no rows.
 * 3. Access guard        — ACCESS_READ makes log_meal forbidden; reads still work.
 * 4. Medallion          — log_meal → nutrition_for returns Gold-view totals.
 * 6. MCP (here)          — tools/list + tools/call over an in-memory transport.
 *
 * Live-view SSE (item 5) is covered in sse.test.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { clone, create, setExtension } from "@bufbuild/protobuf";
import { ServiceOptionsSchema } from "@bufbuild/protobuf/wkt";
import {
  type AppDef,
  type Operation,
  deriveSchema,
  invokeOperation,
  mcpServer,
  openSqlite,
  protoToOperations,
} from "@chamber/datagram";
import { Access, access as accessExt } from "@chamber/proto/chamber/v1/options_pb";
import { NutritionService } from "@chamber/proto/nutrition/v1/nutrition_pb";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { APP_DIR, buildNutritionDatagram, referenceTable } from "../src/service.js";

function op(app: AppDef, name: string): Operation {
  const found = app.operations.find((o) => o.name === name);
  assert.ok(found, `operation ${name} exists`);
  return found;
}

function call(app: AppDef, name: string, body: unknown): unknown {
  const o = op(app, name);
  const parsed = o.validate(body);
  assert.ok(parsed.ok, `valid args for ${name}: ${parsed.ok ? "" : parsed.errors.join("; ")}`);
  return invokeOperation(o, parsed.value);
}

test("injection: a SQL-injection meal name round-trips as a bound param; meals survives", () => {
  const { app, close } = buildNutritionDatagram();
  try {
    const evil = "'; DROP TABLE meals;--";
    const { meal_id } = call(app, "log_meal", {
      name: evil,
      components: [{ component: "egg", qty_g: 100 }],
    }) as { meal_id: string };
    assert.ok(meal_id, "log_meal returned a meal_id");

    const meals = (call(app, "list_meals", {}) as { meals: Array<{ id: string; name: string }> })
      .meals;
    // The table still exists (the malicious string did not execute as SQL)…
    assert.equal(meals.length, 1, "meals table survived; exactly one row");
    // …and the literal injection string is stored verbatim as data.
    assert.equal(meals[0]?.name, evil, "name stored verbatim as a bound parameter");
  } finally {
    close();
  }
});

test("atomicity: a handler that throws mid-log_meal leaves no rows in meals/meal_components", () => {
  // Drive the runner's per-write atomic transaction with a poisoned log handler
  // that inserts a meal + a component and THEN throws — exactly the mid-write
  // failure scenario. The throw happens inside the runner's transaction, so the
  // whole write must roll back and a subsequent read must see no rows.
  const backend = openSqlite(deriveSchema(NutritionService, [referenceTable()]), {
    transformDir: APP_DIR,
  });
  const ops = protoToOperations(NutritionService, backend, {
    logMeal: (_req, { data }) => {
      data.insert("meals", { id: "doomed", name: "doomed", eaten_at: 1 });
      data.insert("meal_components", {
        id: "c1",
        meal_id: "doomed",
        component: "egg",
        qty_g: 100,
      });
      throw new Error("boom mid-write");
    },
    nutritionFor: (_r, { data }) => ({ nutrition: data.query("gold_meal_nutrition") }),
    listMeals: (_r, { data }) => ({ meals: data.query("meals") }),
  });
  try {
    const logOp = ops.find((o) => o.name === "log_meal");
    assert.ok(logOp);
    const parsed = logOp.validate({ description: "x" });
    assert.ok(parsed.ok);
    assert.throws(() => invokeOperation(logOp, parsed.value), /boom mid-write/);

    const meals = backend.readHandle().query("meals");
    const comps = backend.readHandle().query("meal_components");
    assert.equal(meals.length, 0, "no meals persisted (rolled back)");
    assert.equal(comps.length, 0, "no meal_components persisted (rolled back)");
  } finally {
    backend.close();
  }
});

test("access guard: ACCESS_READ makes log_meal forbidden; reads still work", () => {
  // Flip the in-memory service descriptor's access option to ACCESS_READ.
  const readOnly = structuredCloneService();
  const { app, close } = buildNutritionDatagram({ service: readOnly });
  try {
    const logOp = op(app, "log_meal");
    const parsed = logOp.validate({ description: "oatmeal" });
    assert.ok(parsed.ok);
    assert.throws(() => invokeOperation(logOp, parsed.value), /forbidden: read-only dataset/);

    // Reads are unaffected.
    const meals = (call(app, "list_meals", {}) as { meals: unknown[] }).meals;
    assert.equal(meals.length, 0);
  } finally {
    close();
  }
});

test("medallion: after log_meal, nutrition_for returns Gold-view macro/micro totals", () => {
  const { app, close } = buildNutritionDatagram();
  try {
    const { meal_id } = call(app, "log_meal", {
      name: "lunch",
      components: [
        { component: "grilled chicken", qty_g: 200 },
        { component: "brown rice", qty_g: 150 },
      ],
    }) as { meal_id: string };

    const rows = (
      call(app, "nutrition_for", { meal_id }) as {
        nutrition: Array<{ nutrient: string; kind: string; unit: string; amount: number }>;
      }
    ).nutrition;
    const by = new Map(rows.map((r) => [r.nutrient, r]));

    // chicken: 31g protein/100g × 2 = 62; rice: 2.6 × 1.5 = 3.9 → 65.9
    assert.ok(Math.abs((by.get("Protein")?.amount ?? 0) - 65.9) < 1e-6, "protein total");
    assert.equal(by.get("Protein")?.kind, "macro");
    // Both macro and micro nutrients are present (the medallion covers both).
    assert.ok(
      rows.some((r) => r.kind === "macro"),
      "has a macro",
    );
    assert.ok(
      rows.some((r) => r.kind === "micro"),
      "has a micro",
    );
    assert.equal(by.get("Iron")?.unit, "mg", "micro unit from the Gold view");
  } finally {
    close();
  }
});

test("mcp: tools/list shows three tools with 2020-12 schemas; tools/call log_meal returns a meal_id", async () => {
  const { app, close } = buildNutritionDatagram();
  const server = mcpServer(app);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["list_meals", "log_meal", "nutrition_for"]);

    const logMeal = tools.find((t) => t.name === "log_meal");
    assert.ok(logMeal?.inputSchema, "log_meal has an inputSchema");
    assert.equal(
      (logMeal.inputSchema as { $schema?: string }).$schema,
      "https://json-schema.org/draft/2020-12/schema",
      "inputSchema declares JSON-Schema 2020-12",
    );
    assert.equal((logMeal.inputSchema as { type?: string }).type, "object");
    const props = (logMeal.inputSchema as { properties?: Record<string, unknown> }).properties;
    assert.ok(props && "description" in props && "components" in props, "expected proto fields");

    const result = await client.callTool({
      name: "log_meal",
      arguments: { description: "oatmeal" },
    });
    const content = (result.content as Array<{ type: string; text: string }>)[0];
    assert.equal(content?.type, "text");
    const payload = JSON.parse(content.text) as { meal_id: string };
    assert.ok(payload.meal_id, "tools/call log_meal returned a meal_id");
  } finally {
    await client.close();
    await server.close();
    close();
  }
});

/**
 * Build a copy of NutritionService whose `access` option is ACCESS_READ.
 *
 * The runner reads the bound via `getOption(service, access)`, which reads the
 * extension off `service.proto.options`. We clone that options message, set the
 * access extension to ACCESS_READ, and return a thin Proxy that serves the
 * patched options — leaving methods/messages untouched.
 */
function structuredCloneService(): typeof NutritionService {
  const svc = NutritionService;
  // The descriptor carries options (it sets the access bound), so clone them.
  const baseOptions = svc.proto.options ?? create(ServiceOptionsSchema);
  const opts = clone(ServiceOptionsSchema, baseOptions);
  setExtension(opts, accessExt, Access.READ);
  const patchedProto = new Proxy(svc.proto, {
    get: (t, p, r) => (p === "options" ? opts : Reflect.get(t, p, r)),
  });
  return new Proxy(svc, {
    get: (t, p, r) => (p === "proto" ? patchedProto : Reflect.get(t, p, r)),
  }) as typeof NutritionService;
}
