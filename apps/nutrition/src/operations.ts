/**
 * operations.ts — Core data operations for the nutrition tracker.
 *
 * SAFETY INVARIANT (Chamber injection-safety property):
 *   Every value derived from user input is passed as a bound parameter to a
 *   prepared statement. SQL text is never constructed by string concatenation.
 *   This must hold for every read AND write path.
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { NutritionProvider } from "./nutrition_source.js";
import { localProvider } from "./strategies.js";

export interface ComponentSpec {
  component: string;
  qty_g: number;
}

export interface MealRow {
  id: string;
  name: string;
  eaten_at: number;
}

export interface NutritionRow {
  meal_id: string;
  meal_name: string;
  nutrient: string;
  nutrient_kind: string;
  unit: string;
  amount: number;
}

/**
 * logMeal — logs a meal end-to-end in one call: it writes the Bronze rows and then fills the
 * Silver/Gold layers for the meal's components using the chosen resolution strategy (see
 * strategies.ts). Returns the generated meal id.
 *
 * The strategy is only consulted for components that don't already resolve to nutrition locally
 * (seeded reference data or a prior lookup), and every successful lookup is cached into the same
 * silver/gold tables — so "resolve once, replay forever": a component string is looked up at most
 * once across all meals, and the default `local` strategy stays fully offline.
 *
 * Network I/O (for the usda/llm strategies) happens OUTSIDE the DB transactions; each component's
 * writes are their own small idempotent transaction, so a mid-batch failure still leaves the
 * Bronze row and any already-resolved components persisted.
 */
export async function logMeal(
  db: Database.Database,
  name: string,
  components: ComponentSpec[],
  strategy: NutritionProvider = localProvider
): Promise<string> {
  const mealId = randomUUID();
  const now = Date.now();

  // Parameterized prepared statements — Chamber's structural injection-safety guarantee
  const insertMeal = db.prepare(
    `INSERT INTO meals (id, name, eaten_at) VALUES (@id, @name, @eaten_at)`
  );
  const insertComponent = db.prepare(
    `INSERT INTO meal_components (id, meal_id, component, qty_g)
     VALUES (@id, @meal_id, @component, @qty_g)`
  );

  // ── Bronze: raw, immediate ingest ──────────────────────────────────────────
  const writeBronze = db.transaction(() => {
    insertMeal.run({ id: mealId, name, eaten_at: now });
    for (const c of components) {
      insertComponent.run({
        id: randomUUID(),
        meal_id: mealId,
        component: c.component,
        qty_g: c.qty_g,
      });
    }
  });
  writeBronze();

  // ── Silver/Gold: resolve unknown components via the chosen strategy, same call ──
  await fillNutrition(db, components, strategy);
  return mealId;
}

/**
 * fillNutrition — for each distinct component that does NOT already resolve to nutrition locally,
 * ask the strategy for per-100g data and cache it into the silver/gold tables (ingredients +
 * component_ingredients + ingredient_nutrients). Idempotent and offline-safe (the `local`
 * strategy returns nothing, leaving components to whatever the seed data covers).
 */
async function fillNutrition(
  db: Database.Database,
  components: ComponentSpec[],
  strategy: NutritionProvider
): Promise<void> {
  const distinct = [...new Set(components.map((c) => c.component))];

  // A component is already resolvable if its mapping reaches at least one nutrient row.
  const resolvable = db.prepare<{ component: string }, { x: number }>(
    `SELECT 1 AS x FROM component_ingredients ci
     JOIN ingredient_nutrients inu ON inu.ingredient_id = ci.ingredient_id
     WHERE ci.component = @component LIMIT 1`
  );

  const insertIngredient = db.prepare(
    `INSERT OR IGNORE INTO ingredients (id, canonical_name) VALUES (@id, @canonical_name)`
  );
  const insertMapping = db.prepare(
    `INSERT OR IGNORE INTO component_ingredients (component, ingredient_id, fraction)
     VALUES (@component, @ingredient_id, 1.0)`
  );
  const insertIngNut = db.prepare(
    `INSERT OR IGNORE INTO ingredient_nutrients (ingredient_id, nutrient_id, amount_per_100g)
     VALUES (@ingredient_id, @nutrient_id, @amount_per_100g)`
  );

  for (const component of distinct) {
    if (resolvable.get({ component })) continue; // seeded or previously cached → no lookup
    const result = await strategy.lookup(component); // network — outside any transaction
    if (!result) continue; // strategy had no data; component stays unresolved

    const ingredientId = `ing_ext_${result.external_id}`;
    const cache = db.transaction(() => {
      insertIngredient.run({ id: ingredientId, canonical_name: result.canonical_name });
      insertMapping.run({ component, ingredient_id: ingredientId });
      for (const n of result.nutrients) {
        insertIngNut.run({
          ingredient_id: ingredientId,
          nutrient_id: n.nutrient_id,
          amount_per_100g: n.amount_per_100g,
        });
      }
    });
    cache();
  }
}

/**
 * getMealNutrition — reads from the Gold view for a single meal.
 * Macros are returned before micros (matching the view ORDER BY kind).
 */
export function getMealNutrition(
  db: Database.Database,
  mealId: string
): NutritionRow[] {
  // Bound parameter @meal_id — never concatenated into SQL text
  const stmt = db.prepare<{ meal_id: string }, NutritionRow>(
    `SELECT meal_id, meal_name, nutrient, nutrient_kind, unit, amount
     FROM gold_meal_nutrition
     WHERE meal_id = @meal_id
     ORDER BY
       CASE nutrient_kind WHEN 'macro' THEN 0 ELSE 1 END,
       nutrient`
  );
  return stmt.all({ meal_id: mealId });
}

/**
 * listMeals — returns all logged meals, newest first.
 */
export function listMeals(db: Database.Database): MealRow[] {
  const stmt = db.prepare<[], MealRow>(
    `SELECT id, name, eaten_at FROM meals ORDER BY eaten_at DESC`
  );
  return stmt.all();
}

