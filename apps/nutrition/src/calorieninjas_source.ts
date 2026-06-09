/**
 * calorieninjas_source.ts — a CalorieNinjas-backed NutritionProvider (log_meal strategy).
 *
 * Same `NutritionProvider` interface as nutrition_source.ts, so it drops in as a strategy —
 * set NUTRITION_PROVIDER=calorieninjas to use it (see strategies.ts). CalorieNinjas parses a
 * free-text food query and returns nutrition for the matched item; logMeal caches the result
 * so every future log of that component resolves offline ("resolve once, replay forever").
 *
 * API: GET https://api.calorieninjas.com/v1/nutrition?query=<food>, header `X-Api-Key: <key>`.
 * Coverage note: CalorieNinjas returns macros plus a handful of micros (fiber, sugar, saturated
 * fat, sodium, potassium, cholesterol). We emit whatever the item exposes (each with registration
 * metadata so unknown nutrients auto-register) and simply omit anything it doesn't return — the
 * gold SUM treats a missing nutrient as zero, so there's no need to force vit C / iron to 0.
 */

import type { NutritionProvider, ProviderNutrient, ProviderResult } from "./nutrition_source.js";

const CALORIENINJAS_URL = "https://api.calorieninjas.com/v1/nutrition";

/** CalorieNinjas reports values for `serving_size_g`; the rest of the app stores per-100g. */
export interface CalorieNinjasItem {
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

/** CalorieNinjas item field → our nutrient definition (id + registration metadata). */
interface CnNutrientDef {
  field: keyof CalorieNinjasItem;
  id: string;
  name: string;
  kind: "macro" | "micro";
  unit: string;
}

const CN_NUTRIENTS: CnNutrientDef[] = [
  { field: "protein_g",            id: "nut_protein",     name: "Protein",       kind: "macro", unit: "g"  },
  { field: "carbohydrates_total_g", id: "nut_carbs",      name: "Carbs",         kind: "macro", unit: "g"  },
  { field: "fat_total_g",          id: "nut_fat",         name: "Fat",           kind: "macro", unit: "g"  },
  { field: "fiber_g",              id: "nut_fiber",       name: "Fiber",         kind: "macro", unit: "g"  },
  { field: "sugar_g",              id: "nut_sugars",      name: "Sugars",        kind: "macro", unit: "g"  },
  { field: "fat_saturated_g",      id: "nut_sat_fat",     name: "Saturated Fat", kind: "macro", unit: "g"  },
  { field: "sodium_mg",            id: "nut_sodium",      name: "Sodium",        kind: "micro", unit: "mg" },
  { field: "potassium_mg",         id: "nut_potassium",   name: "Potassium",     kind: "micro", unit: "mg" },
  { field: "cholesterol_mg",       id: "nut_cholesterol", name: "Cholesterol",   kind: "micro", unit: "mg" },
];

/** Stable slug so the same food maps to the same ingredient id on every lookup (idempotent cache). */
function slug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Raw CalorieNinjas query: returns every item the API parsed out of the free-text query (it splits
 * a multi-food string like "sausage egg and cheese bagel" into one item per food). Shared by the
 * single-food nutrition provider (which takes item[0]) and the meal parser (which takes them all).
 */
export async function fetchCalorieNinjasItems(query: string): Promise<CalorieNinjasItem[]> {
  const apiKey = process.env.CALORIENINJAS_API_KEY;
  if (!apiKey) {
    throw new Error("CalorieNinjas requires CALORIENINJAS_API_KEY to be set.");
  }

  const url = new URL(CALORIENINJAS_URL);
  url.searchParams.set("query", query);

  const resp = await fetch(url, { headers: { "X-Api-Key": apiKey } });
  if (!resp.ok) {
    throw new Error(`CalorieNinjas lookup failed (${resp.status}) for "${query}"`);
  }
  const data = (await resp.json()) as { items?: CalorieNinjasItem[] };
  return data.items ?? [];
}

export const calorieNinjasProvider: NutritionProvider = {
  async lookup(query: string): Promise<ProviderResult | null> {
    const item = (await fetchCalorieNinjasItems(query))[0];
    if (!item) return null;

    // Normalize the returned serving to per-100g (CalorieNinjas defaults to 100g for a bare name).
    const per100 = (v: number) =>
      item.serving_size_g > 0 ? (v / item.serving_size_g) * 100 : v;

    const nutrients: ProviderNutrient[] = [];
    for (const def of CN_NUTRIENTS) {
      const raw = item[def.field];
      if (typeof raw === "number") {
        nutrients.push({
          nutrient_id: def.id,
          amount_per_100g: per100(raw),
          name: def.name,
          kind: def.kind,
          unit: def.unit,
        });
      }
    }

    return {
      canonical_name: String(item.name ?? query).toLowerCase(),
      external_id: `cn_${slug(item.name ?? query)}`,
      nutrients,
    };
  },
};
