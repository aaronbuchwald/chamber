/**
 * strategy.test.ts — the injectable strategy seam, keyless and deterministic.
 *
 * 1. Empty-seed invariant (HARD REQUIREMENT): building the datagram with an ONLINE
 *    strategy (one carrying no seed) creates `component_nutrients` EMPTY — the offline
 *    seed JSON is NOT loaded on that path. Asserted before any meal is logged.
 * 2. Dynamic resolution: a stub online strategy resolves a component's per-100g rows
 *    on first log, caches them, and `nutrition_for` returns those totals — with NO seed
 *    present. The stub also proves "resolve once, replay forever" (a second log of the
 *    same component does not re-resolve).
 *
 * Both use an in-process stub strategy, so this test stays keyless and runs in default CI.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveSchema, invokeOperation, openSqlite } from "@chamber/datagram";
import { NutritionService } from "@chamber/proto/nutrition/v1/nutrition_pb";
import { APP_DIR, buildNutritionDatagram, referenceTable } from "../src/service.js";
import { offlineStrategy } from "../src/strategies.js";
import type { NutritionStrategy, ReferenceRow } from "../src/strategies.js";

/** A keyless stub "online" strategy: no seed, resolve() counts calls and returns fixed rows. */
function stubStrategy(): { strategy: NutritionStrategy; calls: () => number } {
  let calls = 0;
  const strategy: NutritionStrategy = {
    name: "stub",
    // NOTE: deliberately no `seed` — this is what makes component_nutrients start empty.
    async resolve(component: string): Promise<ReferenceRow[] | null> {
      calls++;
      if (component === "unknownium") return null; // can't resolve → no contribution
      return [
        { component, nutrient: "Protein", kind: "macro", unit: "g", amount_per_100g: 20 },
        { component, nutrient: "Iron", kind: "micro", unit: "mg", amount_per_100g: 2 },
      ];
    },
  };
  return { strategy, calls: () => calls };
}

async function call(
  app: ReturnType<typeof buildNutritionDatagram>["app"],
  name: string,
  body: unknown,
) {
  const op = app.operations.find((o) => o.name === name);
  assert.ok(op, `operation ${name} exists`);
  const parsed = op.validate(body);
  assert.ok(parsed.ok, `valid args for ${name}`);
  return await invokeOperation(app, op, parsed.value);
}

test("empty-seed invariant: an online strategy creates component_nutrients EMPTY (no seed loaded)", () => {
  // Build the backend exactly as buildNutritionDatagram does, seeding only from the
  // strategy. The online stub carries no seed, so the reference table must be empty
  // immediately on open — before any meal is logged — and the offline JSON untouched.
  const { strategy } = stubStrategy();
  const onlineBackend = openSqlite(
    deriveSchema(NutritionService, [referenceTable(strategy.seed ?? [])]),
    { transformDir: APP_DIR },
  );
  try {
    const rows = onlineBackend.readHandle().query("component_nutrients");
    assert.equal(rows.length, 0, "online strategy → component_nutrients seeded EMPTY");
  } finally {
    onlineBackend.close();
  }

  // Control: the OFFLINE strategy DOES pre-seed the same table from the bundled JSON.
  const offline = offlineStrategy(APP_DIR);
  const offlineBackend = openSqlite(
    deriveSchema(NutritionService, [referenceTable(offline.seed ?? [])]),
    { transformDir: APP_DIR },
  );
  try {
    const rows = offlineBackend.readHandle().query("component_nutrients");
    assert.ok(rows.length > 0, "offline strategy → component_nutrients pre-seeded");
  } finally {
    offlineBackend.close();
  }
});

test("empty-seed invariant: with NO seed, an unresolvable component yields zero Gold rows", async () => {
  const { strategy, calls } = stubStrategy();
  const { app, close } = buildNutritionDatagram({ strategy });
  try {
    // "grilled chicken" exists in the OFFLINE seed; under the online strategy it must
    // NOT be pre-seeded — its nutrition comes only from resolve(). Log an UNRESOLVABLE
    // component and confirm the Gold view is empty (nothing seeded, nothing resolved).
    const { meal_id } = (await call(app, "log_meal", {
      components: [{ component: "unknownium", qty_g: 100 }],
    })) as { meal_id: string };
    const { nutrition } = (await call(app, "nutrition_for", { meal_id })) as {
      nutrition: unknown[];
    };
    assert.equal(nutrition.length, 0, "no seed + unresolvable component → empty Gold view");
    assert.equal(calls(), 1, "resolve() was consulted exactly once for the component");
  } finally {
    close();
  }
});

test("concurrent log_meal for the SAME novel component: both meals land, reference rows deduped (no PK race)", async () => {
  // Two requests for the same never-seen component interleave: each `prepare`
  // checks the cache OUTSIDE the txn, both miss, both resolve, and both `commit`
  // try to cache the same (component, nutrient) composite-PK rows. Without the
  // INSERT OR IGNORE fix the second commit hits the UNIQUE constraint and rolls
  // its whole meal back. A gate makes both prepares overlap before either commits.
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const strategy: NutritionStrategy = {
    name: "gated-stub",
    async resolve(component: string): Promise<ReferenceRow[] | null> {
      calls++;
      await gate; // hold BOTH resolutions open so their prepares interleave
      return [
        { component, nutrient: "Protein", kind: "macro", unit: "g", amount_per_100g: 20 },
        { component, nutrient: "Iron", kind: "micro", unit: "mg", amount_per_100g: 2 },
      ];
    },
  };
  const { app, close } = buildNutritionDatagram({ strategy });
  try {
    const logOp = app.operations.find((o) => o.name === "log_meal");
    assert.ok(logOp);
    const args = () => {
      const parsed = logOp.validate({ components: [{ component: "novelfood", qty_g: 100 }] });
      assert.ok(parsed.ok);
      return parsed.value;
    };
    // Start BOTH invocations; their prepares both run resolve() and block on the
    // gate, so neither has committed yet — the classic interleave.
    const first = invokeOperation(app, logOp, args()) as Promise<{ meal_id: string }>;
    const second = invokeOperation(app, logOp, args()) as Promise<{ meal_id: string }>;
    await new Promise((r) => setTimeout(r, 20)); // let both prepares reach the gate
    release(); // both resolutions complete → both commits run
    const [a, b] = await Promise.all([first, second]);

    assert.ok(a.meal_id && b.meal_id, "both meals committed (neither rolled back)");
    assert.notEqual(a.meal_id, b.meal_id, "two distinct meals");
    assert.equal(
      calls,
      2,
      "both requests resolved the component (the interleave actually happened)",
    );

    // Both meals persisted…
    const { meals } = (await call(app, "list_meals", {})) as { meals: unknown[] };
    assert.equal(meals.length, 2, "both meals landed");

    // …and the reference rows are deduped to one (component, nutrient) per pair.
    const { nutrition: nutA } = (await call(app, "nutrition_for", { meal_id: a.meal_id })) as {
      nutrition: Array<{ nutrient: string; amount: number }>;
    };
    const byNutrient = new Map(nutA.map((r) => [r.nutrient, r.amount]));
    assert.equal(byNutrient.get("Protein"), 20, "single deduped Protein row (20/100g × 100g)");
    assert.equal(byNutrient.get("Iron"), 2, "single deduped Iron row");
    assert.equal(nutA.length, 2, "exactly the two deduped nutrient rows, no duplicates");
  } finally {
    close();
  }
});

test("dynamic resolution: an online strategy resolves, caches, and totals; resolve-once-replay-forever", async () => {
  const { strategy, calls } = stubStrategy();
  const { app, close } = buildNutritionDatagram({ strategy });
  try {
    const { meal_id } = (await call(app, "log_meal", {
      name: "lunch",
      components: [{ component: "grilled chicken", qty_g: 200 }],
    })) as { meal_id: string };

    const { nutrition } = (await call(app, "nutrition_for", { meal_id })) as {
      nutrition: Array<{ nutrient: string; kind: string; unit: string; amount: number }>;
    };
    const by = new Map(nutrition.map((r) => [r.nutrient, r]));
    // 20g protein/100g × 2 = 40; resolved from the stub, NOT from any seed.
    assert.ok(Math.abs((by.get("Protein")?.amount ?? 0) - 40) < 1e-6, "resolved protein total");
    assert.equal(by.get("Iron")?.amount, 4, "resolved iron total (2mg/100g × 2)");
    assert.equal(calls(), 1, "resolve() called once for the new component");

    // Log the SAME component again — it's now cached, so resolve() is NOT called again.
    await call(app, "log_meal", {
      name: "dinner",
      components: [{ component: "grilled chicken", qty_g: 100 }],
    });
    assert.equal(calls(), 1, "cached component is not re-resolved (resolve once, replay forever)");
  } finally {
    close();
  }
});
