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

/**
 * A per-100g nutrient amount keyed by our local nutrient id (see data/nutrients.json).
 *
 * The optional name/kind/unit metadata lets a provider return nutrients we don't yet track:
 * fillNutrition auto-registers any unknown nutrient_id into the `nutrients` table using this
 * metadata (INSERT OR IGNORE), so new nutrients (e.g. Vitamin B2) appear automatically for the
 * meals that have them while historical meals stay at zero (excluded from the gold SUM). When a
 * provider returns one of the seeded nutrients it may omit the metadata — those ids already exist.
 */
export interface ProviderNutrient {
  nutrient_id: string;
  amount_per_100g: number;
  /** Display name, e.g. "Vitamin B2". Required to auto-register a nutrient_id we don't track yet. */
  name?: string;
  /** "macro" or "micro" — required to auto-register an unknown nutrient_id. */
  kind?: "macro" | "micro";
  /** Unit, e.g. "g" | "mg" | "mcg" — required to auto-register an unknown nutrient_id. */
  unit?: string;
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

/**
 * USDA FDC nutrient numbers → our local nutrient definition (id + registration metadata). The
 * first five reuse the seeded canonical ids/names; the rest are the comprehensive panel USDA
 * exposes, each carrying name/kind/unit so fillNutrition can auto-register them on first sight.
 */
interface NutrientDef {
  id: string;
  name: string;
  kind: "macro" | "micro";
  unit: string;
}

const USDA_NUTRIENTS: Record<string, NutrientDef> = {
  // ── canonical seeded five (ids/names must stay in sync with data/nutrients.json) ──
  "1003": { id: "nut_protein", name: "Protein",   kind: "macro", unit: "g"  }, // Protein
  "1005": { id: "nut_carbs",   name: "Carbs",     kind: "macro", unit: "g"  }, // Carbohydrate, by difference
  "1004": { id: "nut_fat",     name: "Fat",       kind: "macro", unit: "g"  }, // Total lipid (fat)
  "1162": { id: "nut_vitc",    name: "Vitamin C", kind: "micro", unit: "mg" }, // Vitamin C
  "1089": { id: "nut_iron",    name: "Iron",      kind: "micro", unit: "mg" }, // Iron, Fe
  // ── additional macros ──
  "1079": { id: "nut_fiber",       name: "Fiber",             kind: "macro", unit: "g" }, // Fiber, total dietary
  "2000": { id: "nut_sugars",      name: "Sugars",            kind: "macro", unit: "g" }, // Total sugars
  "1258": { id: "nut_sat_fat",     name: "Saturated Fat",     kind: "macro", unit: "g" }, // Fatty acids, total saturated
  "1292": { id: "nut_mono_fat",    name: "Monounsaturated Fat", kind: "macro", unit: "g" }, // total monounsaturated
  "1293": { id: "nut_poly_fat",    name: "Polyunsaturated Fat", kind: "macro", unit: "g" }, // total polyunsaturated
  // ── vitamins (micros) ──
  "1106": { id: "nut_vita",   name: "Vitamin A",  kind: "micro", unit: "mcg" }, // Vitamin A, RAE
  "1165": { id: "nut_vitb1",  name: "Vitamin B1", kind: "micro", unit: "mg"  }, // Thiamin
  "1166": { id: "nut_vitb2",  name: "Vitamin B2", kind: "micro", unit: "mg"  }, // Riboflavin
  "1167": { id: "nut_vitb3",  name: "Vitamin B3", kind: "micro", unit: "mg"  }, // Niacin
  "1175": { id: "nut_vitb6",  name: "Vitamin B6", kind: "micro", unit: "mg"  }, // Vitamin B-6
  "1177": { id: "nut_folate", name: "Folate",     kind: "micro", unit: "mcg" }, // Folate, total
  "1178": { id: "nut_vitb12", name: "Vitamin B12", kind: "micro", unit: "mcg" }, // Vitamin B-12
  "1114": { id: "nut_vitd",   name: "Vitamin D",  kind: "micro", unit: "mcg" }, // Vitamin D (D2 + D3)
  "1109": { id: "nut_vite",   name: "Vitamin E",  kind: "micro", unit: "mg"  }, // Vitamin E (alpha-tocopherol)
  "1185": { id: "nut_vitk",   name: "Vitamin K",  kind: "micro", unit: "mcg" }, // Vitamin K (phylloquinone)
  // ── minerals (micros) ──
  "1087": { id: "nut_calcium",   name: "Calcium",   kind: "micro", unit: "mg" }, // Calcium, Ca
  "1090": { id: "nut_magnesium", name: "Magnesium", kind: "micro", unit: "mg" }, // Magnesium, Mg
  "1092": { id: "nut_potassium", name: "Potassium", kind: "micro", unit: "mg" }, // Potassium, K
  "1093": { id: "nut_sodium",    name: "Sodium",    kind: "micro", unit: "mg" }, // Sodium, Na
  "1095": { id: "nut_zinc",      name: "Zinc",      kind: "micro", unit: "mg" }, // Zinc, Zn
  "1253": { id: "nut_cholesterol", name: "Cholesterol", kind: "micro", unit: "mg" }, // Cholesterol
};

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

    // Search-result foodNutrients are per 100g. Emit every nutrient the food exposes that we can
    // map, carrying registration metadata so unknown ones auto-register. Nutrients the source
    // doesn't return are simply omitted (treated as zero by the gold SUM) rather than forced to 0.
    const nutrients: ProviderNutrient[] = [];
    for (const fn of food.foodNutrients ?? []) {
      const def = USDA_NUTRIENTS[String(fn.nutrientNumber)];
      if (def && typeof fn.value === "number") {
        nutrients.push({
          nutrient_id: def.id,
          amount_per_100g: fn.value,
          name: def.name,
          kind: def.kind,
          unit: def.unit,
        });
      }
    }

    return {
      canonical_name: String(food.description ?? query).toLowerCase(),
      external_id: String(food.fdcId),
      nutrients,
    };
  },
};
