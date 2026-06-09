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
import type { NutritionProvider, ProviderResult } from "./nutrition_source.js";
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
  strategy: NutritionProvider = localProvider,
  eatenAt: number = Date.now()
): Promise<string> {
  const mealId = randomUUID();
  const now = eatenAt;

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
  const stmts = prepareCacheStatements(db);

  // A component is already resolvable if its mapping reaches at least one nutrient row.
  const resolvable = db.prepare<{ component: string }, { x: number }>(
    `SELECT 1 AS x FROM component_ingredients ci
     JOIN ingredient_nutrients inu ON inu.ingredient_id = ci.ingredient_id
     WHERE ci.component = @component LIMIT 1`
  );

  for (const component of distinct) {
    if (resolvable.get({ component })) continue; // seeded or previously cached → no lookup
    const result = await strategy.lookup(component); // network — outside any transaction
    if (!result) continue; // strategy had no data; component stays unresolved
    cacheResult(db, stmts, component, result); // per-component idempotent transaction
  }
}

/** Prepared statements shared by the cache (fill) and re-cache (reprocess) paths. */
function prepareCacheStatements(db: Database.Database) {
  return {
    nutrientExists: db.prepare<{ id: string }, { x: number }>(
      `SELECT 1 AS x FROM nutrients WHERE id = @id LIMIT 1`
    ),
    insertNutrient: db.prepare(
      `INSERT OR IGNORE INTO nutrients (id, name, kind, unit) VALUES (@id, @name, @kind, @unit)`
    ),
    insertIngredient: db.prepare(
      `INSERT OR IGNORE INTO ingredients (id, canonical_name) VALUES (@id, @canonical_name)`
    ),
    insertMapping: db.prepare(
      `INSERT OR IGNORE INTO component_ingredients (component, ingredient_id, fraction)
       VALUES (@component, @ingredient_id, 1.0)`
    ),
    insertIngNut: db.prepare(
      `INSERT OR IGNORE INTO ingredient_nutrients (ingredient_id, nutrient_id, amount_per_100g)
       VALUES (@ingredient_id, @nutrient_id, @amount_per_100g)`
    ),
  };
}

type CacheStatements = ReturnType<typeof prepareCacheStatements>;

/**
 * cacheResult — persist one provider result (ingredient + mapping + per-nutrient rows) in a single
 * idempotent transaction. Before inserting each ingredient_nutrients row it auto-registers the
 * nutrient if we don't track it yet, using the provider-supplied name/kind/unit (INSERT OR IGNORE).
 * A nutrient_id that is neither already registered nor carries metadata is skipped (it can't be
 * registered, and the gold view would drop an orphan row anyway). New nutrients appear only for the
 * meals that have them; historical meals stay at zero with no migration.
 *
 * Returns the number of nutrient ids newly registered into the nutrients table during this call.
 */
function cacheResult(
  db: Database.Database,
  stmts: CacheStatements,
  component: string,
  result: ProviderResult
): number {
  const ingredientId = `ing_ext_${result.external_id}`;
  let newlyRegistered = 0;
  const cache = db.transaction(() => {
    stmts.insertIngredient.run({ id: ingredientId, canonical_name: result.canonical_name });
    stmts.insertMapping.run({ component, ingredient_id: ingredientId });
    for (const n of result.nutrients) {
      const known = !!stmts.nutrientExists.get({ id: n.nutrient_id });
      if (!known) {
        // Auto-register only if the provider supplied enough metadata to define the nutrient.
        if (n.name && (n.kind === "macro" || n.kind === "micro") && n.unit) {
          const info = stmts.insertNutrient.run({
            id: n.nutrient_id,
            name: n.name,
            kind: n.kind,
            unit: n.unit,
          });
          if (info.changes > 0) newlyRegistered++;
        } else {
          continue; // unknown nutrient with no metadata → can't register; skip the row
        }
      }
      stmts.insertIngNut.run({
        ingredient_id: ingredientId,
        nutrient_id: n.nutrient_id,
        amount_per_100g: n.amount_per_100g,
      });
    }
  });
  cache();
  return newlyRegistered;
}

/** Summary returned by reprocessMeals. */
export interface ReprocessSummary {
  meals_scanned: number;
  components_relooked: number;
  nutrients_added: number;
}

/**
 * reprocessMeals — re-run the CURRENT strategy over the components of meals in a date range
 * (eaten_at within [from, to]; omit both for full history) and refresh their cached nutrition.
 *
 * Unlike logMeal's "resolve once, replay forever" caching, reprocess deliberately BYPASSES the
 * already-resolvable check: it re-looks-up every in-range component via the current strategy and
 * upserts the fresh per-100g values, so changed amounts and newly-added nutrients surface. Network
 * lookups happen outside any transaction; each component's re-cache is its own idempotent
 * transaction (mirroring logMeal). A component whose lookup returns null is left untouched.
 */
export async function reprocessMeals(
  db: Database.Database,
  strategy: NutritionProvider,
  opts: { from?: number; to?: number } = {}
): Promise<ReprocessSummary> {
  const { from, to } = opts;

  // Meals in range (inclusive bounds; either side optional). Bound parameters only — never
  // interpolated. SQLite treats a NULL bound as "no constraint" via the @x IS NULL guards.
  const mealCount = db.prepare<{ from: number | null; to: number | null }, { n: number }>(
    `SELECT COUNT(*) AS n FROM meals
     WHERE (@from IS NULL OR eaten_at >= @from) AND (@to IS NULL OR eaten_at <= @to)`
  );
  const distinctComponents = db.prepare<{ from: number | null; to: number | null }, { component: string }>(
    `SELECT DISTINCT mc.component
       FROM meal_components mc
       JOIN meals m ON m.id = mc.meal_id
      WHERE (@from IS NULL OR m.eaten_at >= @from) AND (@to IS NULL OR m.eaten_at <= @to)`
  );

  const bounds = { from: from ?? null, to: to ?? null };
  const meals_scanned = mealCount.get(bounds)?.n ?? 0;
  const components = distinctComponents.all(bounds).map((r) => r.component);

  const stmts = prepareCacheStatements(db);
  // Refresh an existing per-100g amount even if the row already exists (re-resolve, don't skip).
  const updateIngNut = db.prepare(
    `UPDATE ingredient_nutrients SET amount_per_100g = @amount_per_100g
      WHERE ingredient_id = @ingredient_id AND nutrient_id = @nutrient_id`
  );

  let components_relooked = 0;
  let nutrients_added = 0;

  for (const component of components) {
    const result = await strategy.lookup(component); // network — outside any transaction
    if (!result) continue; // strategy had no data; leave the component untouched

    components_relooked++;
    const ingredientId = `ing_ext_${result.external_id}`;
    const recache = db.transaction(() => {
      stmts.insertIngredient.run({ id: ingredientId, canonical_name: result.canonical_name });
      stmts.insertMapping.run({ component, ingredient_id: ingredientId });
      for (const n of result.nutrients) {
        const known = !!stmts.nutrientExists.get({ id: n.nutrient_id });
        if (!known) {
          if (n.name && (n.kind === "macro" || n.kind === "micro") && n.unit) {
            const info = stmts.insertNutrient.run({
              id: n.nutrient_id,
              name: n.name,
              kind: n.kind,
              unit: n.unit,
            });
            if (info.changes > 0) nutrients_added++;
          } else {
            continue; // can't register without metadata
          }
        }
        // Upsert: insert the row if new, otherwise overwrite the cached amount with current data.
        const ins = stmts.insertIngNut.run({
          ingredient_id: ingredientId,
          nutrient_id: n.nutrient_id,
          amount_per_100g: n.amount_per_100g,
        });
        if (ins.changes === 0) {
          updateIngNut.run({
            ingredient_id: ingredientId,
            nutrient_id: n.nutrient_id,
            amount_per_100g: n.amount_per_100g,
          });
        }
      }
    });
    recache();
  }

  return { meals_scanned, components_relooked, nutrients_added };
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

