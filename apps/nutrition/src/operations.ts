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
 * logMeal — writes Bronze-layer rows for a new meal.
 * Returns the generated meal id.
 */
export function logMeal(
  db: Database.Database,
  name: string,
  components: ComponentSpec[]
): string {
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

  const doInsert = db.transaction(() => {
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

  doInsert();
  return mealId;
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
