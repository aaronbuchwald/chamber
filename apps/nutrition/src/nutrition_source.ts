/**
 * nutrition_source.ts — external nutrition provider (the online "fill out specifics" path).
 *
 * Phase 4 of docs/nutrition-meal-log-design.md: when a logged component isn't in our local
 * silver/gold tables, logMeal looks it up from an authoritative food database via this provider
 * (the default log_meal strategy — see strategies.ts), then caches the result into the SAME tables
 * so every future log of that component resolves offline ("resolve once, replay forever"). The
 * provider is an interface so tests can inject a deterministic fake and never touch the network.
 *
 * Default provider: USDA FoodData Central (https://fdc.nal.usda.gov/api-guide.html). A free
 * API key raises the rate limit; absent one we fall back to USDA's shared DEMO_KEY.
 */

/** A per-100g nutrient amount keyed by our local nutrient id (see data/nutrients.json). */
export interface ProviderNutrient {
  nutrient_id: string;
  amount_per_100g: number;
}

export interface ProviderResult {
  canonical_name: string;
  external_id: string; // stable upstream id (USDA fdcId) → used to derive our ingredient id
  nutrients: ProviderNutrient[];
}

export interface NutritionProvider {
  /** Return per-100g nutrition for a free-text food query, or null if nothing matched. */
  lookup(query: string): Promise<ProviderResult | null>;
}

/** USDA FDC nutrient numbers → our local nutrient ids. Only the nutrients we track. */
const USDA_NUTRIENT_NUMBERS: Record<string, string> = {
  "1003": "nut_protein", // Protein (g)
  "1005": "nut_carbs",   // Carbohydrate, by difference (g)
  "1004": "nut_fat",     // Total lipid (fat) (g)
  "1162": "nut_vitc",    // Vitamin C, total ascorbic acid (mg)
  "1089": "nut_iron",    // Iron, Fe (mg)
};

const ALL_TRACKED = Object.values(USDA_NUTRIENT_NUMBERS);
const USDA_SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search";

export const usdaProvider: NutritionProvider = {
  async lookup(query: string): Promise<ProviderResult | null> {
    const apiKey = process.env.USDA_FDC_API_KEY || "DEMO_KEY";
    const url = new URL(USDA_SEARCH_URL);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("query", query);
    url.searchParams.set("pageSize", "1");
    // Prefer whole-food reference data (per-100g) over branded packaged items.
    url.searchParams.set("dataType", "Foundation,SR Legacy");

    const resp = await fetch(url, { headers: { accept: "application/json" } });
    if (!resp.ok) {
      throw new Error(`USDA lookup failed (${resp.status}) for "${query}"`);
    }
    const data = (await resp.json()) as any;
    const food = data?.foods?.[0];
    if (!food) return null;

    // Search-result foodNutrients are per 100g. Fill all tracked nutrients (0 if absent) so
    // the cached ingredient has a complete profile, matching the bundled-seed convention.
    const found: Record<string, number> = {};
    for (const fn of food.foodNutrients ?? []) {
      const localId = USDA_NUTRIENT_NUMBERS[String(fn.nutrientNumber)];
      if (localId && typeof fn.value === "number") found[localId] = fn.value;
    }
    const nutrients: ProviderNutrient[] = ALL_TRACKED.map((nutrient_id) => ({
      nutrient_id,
      amount_per_100g: found[nutrient_id] ?? 0,
    }));

    return {
      canonical_name: String(food.description ?? query).toLowerCase(),
      external_id: String(food.fdcId),
      nutrients,
    };
  },
};
