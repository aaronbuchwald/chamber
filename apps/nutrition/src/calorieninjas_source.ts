/**
 * calorieninjas_source.ts — a CalorieNinjas-backed NutritionProvider (log_meal strategy).
 *
 * Same `NutritionProvider` interface as nutrition_source.ts, so it drops in as a strategy —
 * set NUTRITION_PROVIDER=calorieninjas to use it (see strategies.ts). CalorieNinjas parses a
 * free-text food query and returns nutrition for the matched item; logMeal caches the result
 * so every future log of that component resolves offline ("resolve once, replay forever").
 *
 * API: GET https://api.calorieninjas.com/v1/nutrition?query=<food>, header `X-Api-Key: <key>`.
 * Coverage note: CalorieNinjas returns macros (protein/carbs/fat) but NOT vitamin C or iron, so
 * those two tracked micros are filled as 0 — matching usdaProvider's "complete profile" convention.
 */

import type { NutritionProvider, ProviderResult } from "./nutrition_source.js";

const CALORIENINJAS_URL = "https://api.calorieninjas.com/v1/nutrition";

/** CalorieNinjas reports values for `serving_size_g`; the rest of the app stores per-100g. */
interface CalorieNinjasItem {
  name: string;
  serving_size_g: number;
  protein_g: number;
  carbohydrates_total_g: number;
  fat_total_g: number;
}

/** Stable slug so the same food maps to the same ingredient id on every lookup (idempotent cache). */
function slug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export const calorieNinjasProvider: NutritionProvider = {
  async lookup(query: string): Promise<ProviderResult | null> {
    const apiKey = process.env.CALORIENINJAS_API_KEY;
    if (!apiKey) {
      throw new Error("NUTRITION_PROVIDER=calorieninjas requires CALORIENINJAS_API_KEY to be set.");
    }

    const url = new URL(CALORIENINJAS_URL);
    url.searchParams.set("query", query);

    const resp = await fetch(url, { headers: { "X-Api-Key": apiKey } });
    if (!resp.ok) {
      throw new Error(`CalorieNinjas lookup failed (${resp.status}) for "${query}"`);
    }
    const data = (await resp.json()) as { items?: CalorieNinjasItem[] };
    const item = data.items?.[0];
    if (!item) return null;

    // Normalize the returned serving to per-100g (CalorieNinjas defaults to 100g for a bare name).
    const per100 = (v: number) =>
      item.serving_size_g > 0 ? (v / item.serving_size_g) * 100 : v;

    return {
      canonical_name: String(item.name ?? query).toLowerCase(),
      external_id: `cn_${slug(item.name ?? query)}`,
      nutrients: [
        { nutrient_id: "nut_protein", amount_per_100g: per100(item.protein_g) },
        { nutrient_id: "nut_carbs", amount_per_100g: per100(item.carbohydrates_total_g) },
        { nutrient_id: "nut_fat", amount_per_100g: per100(item.fat_total_g) },
        { nutrient_id: "nut_vitc", amount_per_100g: 0 }, // not returned by CalorieNinjas
        { nutrient_id: "nut_iron", amount_per_100g: 0 }, // not returned by CalorieNinjas
      ],
    };
  },
};
