/**
 * calorieninjas_strategy.ts — a CalorieNinjas-backed NutritionStrategy.
 *
 * Ported from apps/nutrition/src/calorieninjas_source.ts. NO seed: `resolve(component)`
 * queries the CalorieNinjas API for a free-text food and maps the matched item's
 * macros/micros into per-100g {@link ReferenceRow}s. The runner caches the result into
 * `component_nutrients`, so each component is looked up at most once ("resolve once,
 * replay forever"). Requires CALORIENINJAS_API_KEY; select via NUTRITION_STRATEGY=calorieninjas.
 *
 * API: GET https://api.calorieninjas.com/v1/nutrition?query=<food>, header `X-Api-Key: <key>`.
 * CalorieNinjas reports values for `serving_size_g`; we normalize to per-100g. It returns
 * whatever it has (macros + a few micros); anything it omits simply doesn't contribute (the
 * Gold SUM treats a missing nutrient as zero).
 */

import type { NutritionStrategy, ReferenceRow } from "./strategies.js";

const CALORIENINJAS_URL = "https://api.calorieninjas.com/v1/nutrition";

/** CalorieNinjas reports values for `serving_size_g`; the rest of the app stores per-100g. */
interface CalorieNinjasItem {
  name: string;
  serving_size_g: number;
  protein_g: number;
  carbohydrates_total_g: number;
  fat_total_g: number;
  fiber_g?: number;
  sugar_g?: number;
  fat_saturated_g?: number;
  sodium_mg?: number;
  potassium_mg?: number;
  cholesterol_mg?: number;
}

/** CalorieNinjas item field → our reference-row nutrient (display name + kind + unit). */
interface CnNutrientDef {
  field: keyof CalorieNinjasItem;
  nutrient: string;
  kind: "macro" | "micro";
  unit: string;
}

const CN_NUTRIENTS: CnNutrientDef[] = [
  { field: "protein_g", nutrient: "Protein", kind: "macro", unit: "g" },
  { field: "carbohydrates_total_g", nutrient: "Carbs", kind: "macro", unit: "g" },
  { field: "fat_total_g", nutrient: "Fat", kind: "macro", unit: "g" },
  { field: "fiber_g", nutrient: "Fiber", kind: "macro", unit: "g" },
  { field: "sugar_g", nutrient: "Sugars", kind: "macro", unit: "g" },
  { field: "fat_saturated_g", nutrient: "Saturated Fat", kind: "macro", unit: "g" },
  { field: "sodium_mg", nutrient: "Sodium", kind: "micro", unit: "mg" },
  { field: "potassium_mg", nutrient: "Potassium", kind: "micro", unit: "mg" },
  { field: "cholesterol_mg", nutrient: "Cholesterol", kind: "micro", unit: "mg" },
];

/** The CalorieNinjas strategy: no seed; resolve via the live API. */
export const calorieNinjasStrategy: NutritionStrategy = {
  name: "calorieninjas",
  async resolve(component: string): Promise<ReferenceRow[] | null> {
    const apiKey = process.env.CALORIENINJAS_API_KEY;
    if (!apiKey) {
      throw new Error("NUTRITION_STRATEGY=calorieninjas requires CALORIENINJAS_API_KEY to be set.");
    }

    const url = new URL(CALORIENINJAS_URL);
    url.searchParams.set("query", component);
    const resp = await fetch(url, { headers: { "X-Api-Key": apiKey } });
    if (!resp.ok) {
      throw new Error(`CalorieNinjas lookup failed (${resp.status}) for "${component}"`);
    }
    const data = (await resp.json()) as { items?: CalorieNinjasItem[] };
    const item = data.items?.[0];
    if (!item) return null;

    // Normalize the returned serving to per-100g (CalorieNinjas defaults to 100g for a bare name).
    const per100 = (v: number) => (item.serving_size_g > 0 ? (v / item.serving_size_g) * 100 : v);

    const rows: ReferenceRow[] = [];
    for (const def of CN_NUTRIENTS) {
      const raw = item[def.field];
      if (typeof raw === "number" && Number.isFinite(raw)) {
        rows.push({
          component,
          nutrient: def.nutrient,
          kind: def.kind,
          unit: def.unit,
          amount_per_100g: per100(raw),
        });
      }
    }
    return rows.length > 0 ? rows : null;
  },
};
