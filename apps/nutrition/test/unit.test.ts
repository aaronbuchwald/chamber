/**
 * unit.test.ts — Unit tests for nutrition app core logic.
 *
 * Tests the db/operations/seed/app-layer logic directly (no subprocesses).
 * Each test suite opens a fresh in-memory SQLite DB so there is no shared state.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

// We open DB in-memory so process.cwd() doesn't matter for unit tests.
// Re-export openDb logic inline to allow in-memory usage.
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

// Inline the schema from db.ts (so we don't depend on process.cwd() DB path)
function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meals (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      eaten_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meal_components (
      id          TEXT PRIMARY KEY,
      meal_id     TEXT NOT NULL REFERENCES meals(id),
      component   TEXT NOT NULL,
      qty_g       REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ingredients (
      id             TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS component_ingredients (
      component     TEXT NOT NULL,
      ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
      fraction      REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (component, ingredient_id)
    );
    CREATE TABLE IF NOT EXISTS nutrients (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('macro','micro')),
      unit TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ingredient_nutrients (
      ingredient_id   TEXT NOT NULL REFERENCES ingredients(id),
      nutrient_id     TEXT NOT NULL REFERENCES nutrients(id),
      amount_per_100g REAL NOT NULL,
      PRIMARY KEY (ingredient_id, nutrient_id)
    );
    CREATE VIEW IF NOT EXISTS gold_meal_nutrition AS
    SELECT
      m.id           AS meal_id,
      m.name         AS meal_name,
      n.name         AS nutrient,
      n.kind         AS nutrient_kind,
      n.unit         AS unit,
      SUM(mc.qty_g / 100.0 * ci.fraction * inu.amount_per_100g) AS amount
    FROM meals m
    JOIN meal_components    mc  ON mc.meal_id       = m.id
    JOIN component_ingredients ci ON ci.component   = mc.component
    JOIN ingredient_nutrients  inu ON inu.ingredient_id = ci.ingredient_id
    JOIN nutrients             n   ON n.id           = inu.nutrient_id
    GROUP BY m.id, n.id;
  `);
}

function freshDb(): Database.Database {
  const db = makeDb();
  applySchema(db);
  return db;
}

// ── Lazy imports (ESM dynamic import for the app's own modules) ──────────────

// We import at top level — tsx will handle TS resolution for us.
import { seedReferenceData } from "../src/seed.js";
import { logMeal, getMealNutrition, listMeals, reprocessMeals } from "../src/operations.js";
import type { NutritionProvider, ProviderResult } from "../src/nutrition_source.js";
import { app } from "../src/app.js";
import { z } from "../../../packages/appkit/src/index.js";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("logMeal", () => {
  it("writes Bronze rows and returns a UUID", async () => {
    const db = freshDb();
    seedReferenceData(db);

    const id = await logMeal(db, "Chicken dinner", [{ component: "grilled chicken", qty_g: 150 }]);

    assert.match(id, /^[0-9a-f-]{36}$/, "meal_id should be a UUID");

    const meal = db.prepare("SELECT * FROM meals WHERE id = ?").get(id) as any;
    assert.equal(meal.name, "Chicken dinner");
    assert.ok(meal.eaten_at > 0);

    const components = db.prepare("SELECT * FROM meal_components WHERE meal_id = ?").all(id) as any[];
    assert.equal(components.length, 1);
    assert.equal(components[0].component, "grilled chicken");
    assert.equal(components[0].qty_g, 150);
  });
});

describe("getMealNutrition", () => {
  it("returns Gold-view rows with macros before micros", async () => {
    const db = freshDb();
    seedReferenceData(db);

    const id = await logMeal(db, "Grilled chicken", [{ component: "grilled chicken", qty_g: 150 }]);
    const rows = getMealNutrition(db, id);

    // Should have 5 nutrients (protein, carbs, fat, vit-c, iron)
    assert.equal(rows.length, 5, `expected 5 nutrient rows, got ${rows.length}`);

    // Macros come first
    const macros = rows.filter((r) => r.nutrient_kind === "macro");
    const micros = rows.filter((r) => r.nutrient_kind === "micro");
    assert.equal(macros.length, 3);
    assert.equal(micros.length, 2);

    const lastMacroIdx = rows.findLastIndex((r) => r.nutrient_kind === "macro");
    const firstMicroIdx = rows.findIndex((r) => r.nutrient_kind === "micro");
    assert.ok(lastMacroIdx < firstMicroIdx, "all macros should come before any micro");
  });

  it("computes a concrete value: 150g grilled chicken → Protein ≈ 46.5g", async () => {
    // Per seed.ts: grilled chicken has 31.0g protein per 100g
    // 150g * 31.0 / 100 = 46.5g
    const db = freshDb();
    seedReferenceData(db);

    const id = await logMeal(db, "Test meal", [{ component: "grilled chicken", qty_g: 150 }]);
    const rows = getMealNutrition(db, id);

    const protein = rows.find((r) => r.nutrient === "Protein");
    assert.ok(protein, "Protein row should exist");
    assert.ok(
      Math.abs(protein!.amount - 46.5) < 0.001,
      `Expected Protein ≈ 46.5g, got ${protein!.amount}`
    );
    assert.equal(protein!.unit, "g");
    assert.equal(protein!.meal_name, "Test meal");
  });

  it("verifies macros are sorted alphabetically within the macro group", async () => {
    const db = freshDb();
    seedReferenceData(db);

    const id = await logMeal(db, "Test meal", [{ component: "grilled chicken", qty_g: 100 }]);
    const rows = getMealNutrition(db, id);
    const macros = rows.filter((r) => r.nutrient_kind === "macro").map((r) => r.nutrient);

    // Should be alphabetically sorted: Carbs, Fat, Protein
    const sorted = [...macros].sort();
    assert.deepEqual(macros, sorted, `macros should be alphabetically sorted, got: ${macros.join(", ")}`);
  });
});

describe("seedReferenceData idempotency", () => {
  it("can be called twice without duplicate rows or errors", async () => {
    const db = freshDb();

    seedReferenceData(db);
    seedReferenceData(db); // second call must not throw or create duplicates

    const ingCount = (db.prepare("SELECT COUNT(*) as n FROM ingredients").get() as any).n;
    const nutCount = (db.prepare("SELECT COUNT(*) as n FROM nutrients").get() as any).n;
    const ciCount = (db.prepare("SELECT COUNT(*) as n FROM component_ingredients").get() as any).n;
    const inCount = (db.prepare("SELECT COUNT(*) as n FROM ingredient_nutrients").get() as any).n;

    // Exact counts from seed.ts
    assert.equal(ingCount, 6,  `Expected 6 ingredients, got ${ingCount}`);
    assert.equal(nutCount, 5,  `Expected 5 nutrients, got ${nutCount}`);
    assert.equal(ciCount,  8,  `Expected 8 component_ingredient mappings, got ${ciCount}`);
    assert.equal(inCount,  30, `Expected 30 ingredient_nutrient rows, got ${inCount}`);
  });
});

describe("component input: both string and object forms", () => {
  // The zod schema is in app.ts. We can access it via app.operations[0].input.
  // The "components" field uses arrayOf(component) which is a union of string transform
  // and object form.
  const logMealOp = app.operations.find((o) => o.name === "log_meal")!;

  it("accepts 'name:grams' string form", async () => {
    const parsed = logMealOp.input.safeParse({
      name: "Breakfast",
      components: "grilled chicken:150",
    });
    assert.ok(parsed.success, `Parse failed: ${JSON.stringify(parsed.error?.issues)}`);
    assert.deepEqual(parsed.data.components, [{ component: "grilled chicken", qty_g: 150 }]);
  });

  it("accepts {component, qty_g} object form", async () => {
    const parsed = logMealOp.input.safeParse({
      name: "Breakfast",
      components: [{ component: "grilled chicken", qty_g: 150 }],
    });
    assert.ok(parsed.success, `Parse failed: ${JSON.stringify(parsed.error?.issues)}`);
    assert.deepEqual(parsed.data.components, [{ component: "grilled chicken", qty_g: 150 }]);
  });

  it("accepts multiple components as an array of strings", async () => {
    const parsed = logMealOp.input.safeParse({
      name: "Combo",
      components: ["grilled chicken:150", "brown rice:100"],
    });
    assert.ok(parsed.success, `Parse failed: ${JSON.stringify(parsed.error?.issues)}`);
    assert.deepEqual(parsed.data.components, [
      { component: "grilled chicken", qty_g: 150 },
      { component: "brown rice", qty_g: 100 },
    ]);
  });

  it("accepts mixed array (strings and objects)", async () => {
    const parsed = logMealOp.input.safeParse({
      name: "Mixed",
      components: ["grilled chicken:150", { component: "brown rice", qty_g: 100 }],
    });
    assert.ok(parsed.success, `Parse failed: ${JSON.stringify(parsed.error?.issues)}`);
    assert.deepEqual(parsed.data.components, [
      { component: "grilled chicken", qty_g: 150 },
      { component: "brown rice", qty_g: 100 },
    ]);
  });

  it("rejects malformed string (missing grams)", async () => {
    const parsed = logMealOp.input.safeParse({
      name: "Bad",
      components: "grilled chicken",
    });
    assert.ok(!parsed.success, "Expected parse to fail for string without grams");
  });

  it("rejects negative qty_g in object form", async () => {
    const parsed = logMealOp.input.safeParse({
      name: "Bad",
      components: [{ component: "chicken", qty_g: -10 }],
    });
    assert.ok(!parsed.success, "Expected parse to fail for negative qty_g");
  });
});

describe("injection safety", () => {
  it("stores a SQL injection string verbatim and leaves meals table intact", async () => {
    const db = freshDb();
    seedReferenceData(db);

    const maliciousName = `'); DROP TABLE meals;--`;
    const id = await logMeal(db, maliciousName, [{ component: "grilled chicken", qty_g: 100 }]);

    // The meal name should be stored verbatim
    const meal = db.prepare("SELECT name FROM meals WHERE id = ?").get(id) as any;
    assert.equal(meal.name, maliciousName, "Meal name should be stored verbatim");

    // The meals table should still be intact (list_meals still works)
    const meals = listMeals(db);
    assert.ok(meals.length >= 1, "meals table should still be intact after injection attempt");
    assert.ok(meals.some((m) => m.id === id), "Our meal should be in the list");
  });
});

describe("unknown component", () => {
  it("nutrition_for returns no rows for an unknown component", async () => {
    const db = freshDb();
    seedReferenceData(db);

    // Log a meal with a component not in reference data
    const id = await logMeal(db, "Unknown dish", [{ component: "unicorn meat", qty_g: 100 }]);

    // Should return no rows (the JOIN to component_ingredients will find nothing)
    const rows = getMealNutrition(db, id);
    assert.equal(rows.length, 0, "No nutrition rows expected for unknown component");
  });
});

describe("logMeal strategy resolution (offline, fake strategy)", () => {
  // A deterministic in-memory strategy — never touches the network. It records every lookup so we
  // can assert a second meal using the same component resolves from cache (no re-lookup).
  function makeFakeStrategy(): NutritionProvider & { lookups: string[] } {
    const lookups: string[] = [];
    return {
      lookups,
      async lookup(query: string): Promise<ProviderResult | null> {
        lookups.push(query);
        if (query === "unicorn meat") {
          return {
            canonical_name: "unicorn meat",
            external_id: "fake-unicorn-1",
            nutrients: [
              { nutrient_id: "nut_protein", amount_per_100g: 20 },
              { nutrient_id: "nut_carbs", amount_per_100g: 0 },
              { nutrient_id: "nut_fat", amount_per_100g: 10 },
              { nutrient_id: "nut_vitc", amount_per_100g: 0 },
              { nutrient_id: "nut_iron", amount_per_100g: 3 },
            ],
          };
        }
        return null; // unknown to the strategy
      },
    };
  }

  it("fills nutrition in one go via the strategy, then replays from cache for later meals", async () => {
    const db = freshDb();
    seedReferenceData(db);
    const fake = makeFakeStrategy();

    // log_meal resolves "unicorn meat" in the SAME call — strategy consulted exactly once.
    const id = await logMeal(db, "Mythical platter", [{ component: "unicorn meat", qty_g: 100 }], fake);
    assert.equal(fake.lookups.length, 1, "strategy should be consulted exactly once during logMeal");

    // Nutrition reflects the freshly cached data immediately: 100g * 20/100 = 20g protein.
    const rows = getMealNutrition(db, id);
    assert.equal(rows.length, 5, `expected 5 nutrient rows after logMeal, got ${rows.length}`);
    const protein = rows.find((r) => r.nutrient === "Protein");
    assert.ok(protein, "Protein row should exist after logMeal");
    assert.ok(
      Math.abs(protein!.amount - 20) < 0.001,
      `Expected Protein ≈ 20g, got ${protein!.amount}`
    );

    // A second meal with the same component resolves from cache — strategy NOT consulted again.
    const id2 = await logMeal(db, "Unicorn again", [{ component: "unicorn meat", qty_g: 50 }], fake);
    assert.equal(fake.lookups.length, 1, "strategy must NOT be consulted again (resolve once, replay forever)");
    const rows2 = getMealNutrition(db, id2);
    assert.equal(rows2.length, 5, "second meal resolves entirely from cache");
    const protein2 = rows2.find((r) => r.nutrient === "Protein");
    assert.ok(protein2 && Math.abs(protein2.amount - 10) < 0.001, `Expected Protein ≈ 10g, got ${protein2?.amount}`);
  });

  it("leaves components the strategy has no data for unresolved", async () => {
    const db = freshDb();
    seedReferenceData(db);
    const fake = makeFakeStrategy();

    const id = await logMeal(db, "Void soup", [{ component: "dark matter", qty_g: 50 }], fake);
    assert.deepEqual(fake.lookups, ["dark matter"], "strategy is consulted for the unknown component");
    assert.equal(getMealNutrition(db, id).length, 0, "no nutrition for a component the strategy can't resolve");
  });

  it("default (local) strategy stays offline — unmapped components get no nutrition", async () => {
    const db = freshDb();
    seedReferenceData(db);

    // No strategy passed → localProvider → no external lookup, so an unseeded component is empty.
    const id = await logMeal(db, "Mythical platter", [{ component: "unicorn meat", qty_g: 100 }]);
    assert.equal(getMealNutrition(db, id).length, 0, "local strategy resolves only seeded reference data");
  });
});

describe("dynamic comprehensive nutrient set", () => {
  it("auto-registers a brand-new nutrient (Vitamin B2) for the meal that has it, while older meals stay zero", async () => {
    const db = freshDb();
    seedReferenceData(db);

    // Strategy that returns ONLY the seeded five (no metadata) for one food, and a richer panel
    // (including a nutrient we don't track yet — nut_vitb2) for another.
    const strategy: NutritionProvider = {
      async lookup(query: string): Promise<ProviderResult | null> {
        if (query === "plain rice") {
          return {
            canonical_name: "plain rice",
            external_id: "rice-1",
            nutrients: [
              { nutrient_id: "nut_protein", amount_per_100g: 2 },
              { nutrient_id: "nut_carbs", amount_per_100g: 28 },
              { nutrient_id: "nut_fat", amount_per_100g: 0 },
            ],
          };
        }
        if (query === "fortified cereal") {
          return {
            canonical_name: "fortified cereal",
            external_id: "cereal-1",
            nutrients: [
              { nutrient_id: "nut_protein", amount_per_100g: 8 },
              { nutrient_id: "nut_carbs", amount_per_100g: 80 },
              // brand-new nutrient with full registration metadata
              { nutrient_id: "nut_vitb2", name: "Vitamin B2", kind: "micro", unit: "mg", amount_per_100g: 0.3 },
            ],
          };
        }
        return null;
      },
    };

    // Log an OLDER meal first — it never had B2.
    const oldMeal = await logMeal(db, "Rice bowl", [{ component: "plain rice", qty_g: 100 }], strategy);

    // B2 is not registered yet (only the seeded five exist).
    const before = db.prepare("SELECT 1 FROM nutrients WHERE id = 'nut_vitb2'").get();
    assert.equal(before, undefined, "nut_vitb2 must not exist before any food introduces it");

    // Log a NEWER meal whose provider returns B2 — it auto-registers.
    const newMeal = await logMeal(db, "Cereal", [{ component: "fortified cereal", qty_g: 100 }], strategy);

    const registered = db.prepare("SELECT name, kind, unit FROM nutrients WHERE id = 'nut_vitb2'").get() as any;
    assert.ok(registered, "nut_vitb2 should be auto-registered after the cereal meal");
    assert.equal(registered.name, "Vitamin B2");
    assert.equal(registered.kind, "micro");
    assert.equal(registered.unit, "mg");

    // The cereal meal shows B2 (100g * 0.3/100 = 0.3mg)…
    const newRows = getMealNutrition(db, newMeal);
    const b2 = newRows.find((r) => r.nutrient === "Vitamin B2");
    assert.ok(b2, "cereal meal should have a Vitamin B2 row");
    assert.ok(Math.abs(b2!.amount - 0.3) < 1e-9, `expected B2 ≈ 0.3mg, got ${b2!.amount}`);

    // …but the older rice meal has NO B2 row (treated as zero — excluded from the SUM).
    const oldRows = getMealNutrition(db, oldMeal);
    assert.ok(!oldRows.some((r) => r.nutrient === "Vitamin B2"), "older meal must show no Vitamin B2 row (zero)");
  });

  it("skips an unknown nutrient that lacks registration metadata", async () => {
    const db = freshDb();
    seedReferenceData(db);

    const strategy: NutritionProvider = {
      async lookup(): Promise<ProviderResult | null> {
        return {
          canonical_name: "mystery food",
          external_id: "mystery-1",
          nutrients: [
            { nutrient_id: "nut_protein", amount_per_100g: 5 },
            // unknown id with NO metadata → cannot register → skipped
            { nutrient_id: "nut_unobtanium", amount_per_100g: 99 },
          ],
        };
      },
    };

    const id = await logMeal(db, "Mystery", [{ component: "mystery food", qty_g: 100 }], strategy);
    assert.equal(db.prepare("SELECT 1 FROM nutrients WHERE id = 'nut_unobtanium'").get(), undefined);
    const rows = getMealNutrition(db, id);
    assert.ok(rows.some((r) => r.nutrient === "Protein"), "Protein still resolves");
    assert.ok(!rows.some((r) => (r as any).nutrient_id === "nut_unobtanium"), "unregisterable nutrient is dropped");
  });
});

describe("reprocessMeals", () => {
  // A mutable fake whose output we swap between the initial log and the reprocess pass.
  function makeMutableStrategy() {
    const state: { result: ProviderResult | null } = { result: null };
    const lookups: string[] = [];
    const strategy: NutritionProvider = {
      async lookup(query: string): Promise<ProviderResult | null> {
        lookups.push(query);
        return state.result;
      },
    };
    return { strategy, state, lookups };
  }

  it("re-resolves components over a range with the current strategy, updating values and adding nutrients", async () => {
    const db = freshDb();
    seedReferenceData(db);
    const { strategy, state, lookups } = makeMutableStrategy();

    // Initial resolution: protein 10, no B2.
    state.result = {
      canonical_name: "lab meat",
      external_id: "lab-1",
      nutrients: [{ nutrient_id: "nut_protein", amount_per_100g: 10 }],
    };
    const t = 1_000_000_000_000; // fixed timestamp in range
    const meal = await logMeal(db, "Lab plate", [{ component: "lab meat", qty_g: 100 }], strategy, t);

    let rows = getMealNutrition(db, meal);
    assert.ok(Math.abs(rows.find((r) => r.nutrient === "Protein")!.amount - 10) < 1e-9);
    assert.ok(!rows.some((r) => r.nutrient === "Vitamin B2"));
    const lookupsAfterLog = lookups.length;

    // Strategy now returns updated protein AND a new nutrient.
    state.result = {
      canonical_name: "lab meat",
      external_id: "lab-1",
      nutrients: [
        { nutrient_id: "nut_protein", amount_per_100g: 25 },
        { nutrient_id: "nut_vitb2", name: "Vitamin B2", kind: "micro", unit: "mg", amount_per_100g: 0.5 },
      ],
    };

    const summary = await reprocessMeals(db, strategy, { from: t - 1000, to: t + 1000 });
    assert.equal(summary.meals_scanned, 1, "one meal in range");
    assert.equal(summary.components_relooked, 1, "one component re-resolved");
    assert.equal(summary.nutrients_added, 1, "Vitamin B2 newly registered");
    assert.ok(lookups.length > lookupsAfterLog, "reprocess bypasses cache and re-looks-up the component");

    rows = getMealNutrition(db, meal);
    const protein = rows.find((r) => r.nutrient === "Protein");
    assert.ok(protein && Math.abs(protein.amount - 25) < 1e-9, `expected updated Protein ≈ 25g, got ${protein?.amount}`);
    const b2 = rows.find((r) => r.nutrient === "Vitamin B2");
    assert.ok(b2 && Math.abs(b2.amount - 0.5) < 1e-9, `expected new B2 ≈ 0.5mg, got ${b2?.amount}`);
  });

  it("processes full history when no range is given", async () => {
    const db = freshDb();
    seedReferenceData(db);
    const { strategy, state } = makeMutableStrategy();

    state.result = {
      canonical_name: "soylent",
      external_id: "soy-1",
      nutrients: [{ nutrient_id: "nut_protein", amount_per_100g: 4 }],
    };
    const meal = await logMeal(db, "Drink", [{ component: "soylent", qty_g: 100 }], strategy, 5_000);

    state.result = {
      canonical_name: "soylent",
      external_id: "soy-1",
      nutrients: [{ nutrient_id: "nut_protein", amount_per_100g: 9 }],
    };

    const summary = await reprocessMeals(db, strategy); // no from/to → full history
    assert.equal(summary.meals_scanned, 1);
    assert.equal(summary.components_relooked, 1);
    assert.equal(summary.nutrients_added, 0, "no new nutrients this time");

    const protein = getMealNutrition(db, meal).find((r) => r.nutrient === "Protein");
    assert.ok(protein && Math.abs(protein.amount - 9) < 1e-9, `expected reprocessed Protein ≈ 9g, got ${protein?.amount}`);
  });

  it("excludes out-of-range meals and leaves unresolved components untouched", async () => {
    const db = freshDb();
    seedReferenceData(db);
    const { strategy, state } = makeMutableStrategy();

    state.result = {
      canonical_name: "kelp",
      external_id: "kelp-1",
      nutrients: [{ nutrient_id: "nut_protein", amount_per_100g: 2 }],
    };
    const inRange = await logMeal(db, "In", [{ component: "kelp", qty_g: 100 }], strategy, 10_000);
    const outRange = await logMeal(db, "Out", [{ component: "kelp", qty_g: 100 }], strategy, 99_000);

    // Reprocess only the early window; the later meal's eaten_at is outside it.
    state.result = {
      canonical_name: "kelp",
      external_id: "kelp-1",
      nutrients: [{ nutrient_id: "nut_protein", amount_per_100g: 7 }],
    };
    const summary = await reprocessMeals(db, strategy, { to: 50_000 });
    assert.equal(summary.meals_scanned, 1, "only the in-range meal is scanned");
    assert.equal(summary.components_relooked, 1);

    // Both meals share the same component+ingredient, so the cached amount updates for both —
    // but only the in-range meal counted toward meals_scanned. Confirm the value did refresh.
    assert.ok(Math.abs(getMealNutrition(db, inRange).find((r) => r.nutrient === "Protein")!.amount - 7) < 1e-9);
    assert.ok(Math.abs(getMealNutrition(db, outRange).find((r) => r.nutrient === "Protein")!.amount - 7) < 1e-9);
  });

  it("returns a null strategy result without throwing and counts no relooks", async () => {
    const db = freshDb();
    seedReferenceData(db);
    const strategy: NutritionProvider = { async lookup() { return null; } };

    await logMeal(db, "Seeded", [{ component: "grilled chicken", qty_g: 100 }], strategy, 1234);
    const summary = await reprocessMeals(db, strategy);
    assert.equal(summary.meals_scanned, 1);
    assert.equal(summary.components_relooked, 0, "null lookups don't count as relooked");
    assert.equal(summary.nutrients_added, 0);
    // Seeded nutrition for grilled chicken is untouched.
    assert.ok(getMealNutrition(db, listMeals(db)[0].id).length > 0);
  });
});

describe("listMeals", () => {
  it("returns meals newest-first", async () => {
    const db = freshDb();
    seedReferenceData(db);

    // Insert meals with explicit distinct timestamps to ensure deterministic ordering.
    // (When three logMeal() calls happen in the same millisecond, eaten_at ties are
    //  not broken deterministically by ORDER BY eaten_at DESC alone.)
    const baseTime = Date.now();
    // Use crypto.randomUUID which is available as a global in Node 20
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    const id3 = crypto.randomUUID();

    db.prepare("INSERT INTO meals (id, name, eaten_at) VALUES (?, ?, ?)").run(id1, "Breakfast", baseTime);
    db.prepare("INSERT INTO meals (id, name, eaten_at) VALUES (?, ?, ?)").run(id2, "Lunch",     baseTime + 1000);
    db.prepare("INSERT INTO meals (id, name, eaten_at) VALUES (?, ?, ?)").run(id3, "Dinner",    baseTime + 2000);

    const meals = listMeals(db);
    assert.ok(meals.length >= 3);

    // newest first = id3, id2, id1
    const ids = meals.map((m) => m.id);
    const pos3 = ids.indexOf(id3);
    const pos2 = ids.indexOf(id2);
    const pos1 = ids.indexOf(id1);
    assert.ok(pos3 < pos2, "Dinner (newest) should come before Lunch");
    assert.ok(pos2 < pos1, "Lunch should come before Breakfast (oldest)");
  });
});
