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
import { logMeal, getMealNutrition, listMeals, enrichMeal } from "../src/operations.js";
import type { NutritionProvider, ProviderResult } from "../src/nutrition_source.js";
import { app } from "../src/app.js";
import { z } from "../../../packages/appkit/src/index.js";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("logMeal", () => {
  it("writes Bronze rows and returns a UUID", () => {
    const db = freshDb();
    seedReferenceData(db);

    const id = logMeal(db, "Chicken dinner", [{ component: "grilled chicken", qty_g: 150 }]);

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
  it("returns Gold-view rows with macros before micros", () => {
    const db = freshDb();
    seedReferenceData(db);

    const id = logMeal(db, "Grilled chicken", [{ component: "grilled chicken", qty_g: 150 }]);
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

  it("computes a concrete value: 150g grilled chicken → Protein ≈ 46.5g", () => {
    // Per seed.ts: grilled chicken has 31.0g protein per 100g
    // 150g * 31.0 / 100 = 46.5g
    const db = freshDb();
    seedReferenceData(db);

    const id = logMeal(db, "Test meal", [{ component: "grilled chicken", qty_g: 150 }]);
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

  it("verifies macros are sorted alphabetically within the macro group", () => {
    const db = freshDb();
    seedReferenceData(db);

    const id = logMeal(db, "Test meal", [{ component: "grilled chicken", qty_g: 100 }]);
    const rows = getMealNutrition(db, id);
    const macros = rows.filter((r) => r.nutrient_kind === "macro").map((r) => r.nutrient);

    // Should be alphabetically sorted: Carbs, Fat, Protein
    const sorted = [...macros].sort();
    assert.deepEqual(macros, sorted, `macros should be alphabetically sorted, got: ${macros.join(", ")}`);
  });
});

describe("seedReferenceData idempotency", () => {
  it("can be called twice without duplicate rows or errors", () => {
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

  it("accepts 'name:grams' string form", () => {
    const parsed = logMealOp.input.safeParse({
      name: "Breakfast",
      components: "grilled chicken:150",
    });
    assert.ok(parsed.success, `Parse failed: ${JSON.stringify(parsed.error?.issues)}`);
    assert.deepEqual(parsed.data.components, [{ component: "grilled chicken", qty_g: 150 }]);
  });

  it("accepts {component, qty_g} object form", () => {
    const parsed = logMealOp.input.safeParse({
      name: "Breakfast",
      components: [{ component: "grilled chicken", qty_g: 150 }],
    });
    assert.ok(parsed.success, `Parse failed: ${JSON.stringify(parsed.error?.issues)}`);
    assert.deepEqual(parsed.data.components, [{ component: "grilled chicken", qty_g: 150 }]);
  });

  it("accepts multiple components as an array of strings", () => {
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

  it("accepts mixed array (strings and objects)", () => {
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

  it("rejects malformed string (missing grams)", () => {
    const parsed = logMealOp.input.safeParse({
      name: "Bad",
      components: "grilled chicken",
    });
    assert.ok(!parsed.success, "Expected parse to fail for string without grams");
  });

  it("rejects negative qty_g in object form", () => {
    const parsed = logMealOp.input.safeParse({
      name: "Bad",
      components: [{ component: "chicken", qty_g: -10 }],
    });
    assert.ok(!parsed.success, "Expected parse to fail for negative qty_g");
  });
});

describe("injection safety", () => {
  it("stores a SQL injection string verbatim and leaves meals table intact", () => {
    const db = freshDb();
    seedReferenceData(db);

    const maliciousName = `'); DROP TABLE meals;--`;
    const id = logMeal(db, maliciousName, [{ component: "grilled chicken", qty_g: 100 }]);

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
  it("nutrition_for returns no rows for an unknown component", () => {
    const db = freshDb();
    seedReferenceData(db);

    // Log a meal with a component not in reference data
    const id = logMeal(db, "Unknown dish", [{ component: "unicorn meat", qty_g: 100 }]);

    // Should return no rows (the JOIN to component_ingredients will find nothing)
    const rows = getMealNutrition(db, id);
    assert.equal(rows.length, 0, "No nutrition rows expected for unknown component");
  });
});

describe("enrichMeal (offline, fake provider)", () => {
  // A deterministic in-memory provider — never touches the network. It records every
  // lookup so we can assert the second enrichMeal call resolves from cache (no re-lookup).
  function makeFakeProvider(): NutritionProvider & { lookups: string[] } {
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
        return null; // unknown to the provider
      },
    };
  }

  it("fills nutrition for an unmapped component, then is an idempotent cached skip", async () => {
    const db = freshDb();
    seedReferenceData(db);

    // "unicorn meat" is not in the bundled reference data, so it resolves to no nutrition.
    const id = logMeal(db, "Mythical platter", [{ component: "unicorn meat", qty_g: 100 }]);
    assert.equal(getMealNutrition(db, id).length, 0, "unmapped component should start with no nutrients");

    const fake = makeFakeProvider();

    // 1st enrich: provider is consulted once and the result is cached into silver/gold tables.
    const first = await enrichMeal(db, id, fake);
    assert.equal(fake.lookups.length, 1, "provider should be consulted exactly once on first enrich");
    assert.deepEqual(first.enriched, [{ component: "unicorn meat", ingredient: "unicorn meat" }]);
    assert.deepEqual(first.cached, []);
    assert.deepEqual(first.not_found, []);

    // getMealNutrition now reflects the freshly cached data: 100g * 20/100 = 20g protein.
    const rows = getMealNutrition(db, id);
    assert.equal(rows.length, 5, `expected 5 nutrient rows after enrich, got ${rows.length}`);
    const protein = rows.find((r) => r.nutrient === "Protein");
    assert.ok(protein, "Protein row should exist after enrich");
    assert.ok(
      Math.abs(protein!.amount - 20) < 0.001,
      `Expected Protein ≈ 20g, got ${protein!.amount}`
    );

    // 2nd enrich: the component now resolves locally, so it's a cached skip — no 2nd lookup.
    const second = await enrichMeal(db, id, fake);
    assert.equal(fake.lookups.length, 1, "provider must NOT be consulted again (idempotent cache skip)");
    assert.deepEqual(second.enriched, [], "nothing newly enriched on the second call");
    assert.deepEqual(second.cached, ["unicorn meat"], "component should report as cached on second call");
    assert.deepEqual(second.not_found, []);

    // And nutrition is unchanged — no duplicate ingredient/nutrient rows were written.
    assert.deepEqual(getMealNutrition(db, id), rows, "nutrition should be identical after the idempotent re-enrich");
  });

  it("reports components the provider has no data for as not_found", async () => {
    const db = freshDb();
    seedReferenceData(db);

    const id = logMeal(db, "Void soup", [{ component: "dark matter", qty_g: 50 }]);
    const fake = makeFakeProvider();

    const outcome = await enrichMeal(db, id, fake);
    assert.deepEqual(outcome.not_found, ["dark matter"], "provider returned null → not_found");
    assert.deepEqual(outcome.enriched, []);
    assert.equal(getMealNutrition(db, id).length, 0, "still no nutrition for an unresolvable component");
  });
});

describe("listMeals", () => {
  it("returns meals newest-first", () => {
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
