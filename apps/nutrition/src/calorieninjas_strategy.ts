/**
 * calorieninjas_strategy.ts — a CalorieNinjas-backed NutritionStrategy.
 *
 * NO seed: `resolve(component)` queries the CalorieNinjas API for a free-text food and maps
 * EVERY nutrient field the API returns for the matched item into per-100g {@link ReferenceRow}s.
 * Nothing is hardcoded: we enumerate the numeric fields of the response and derive each row's
 * unit from the field-name suffix (`_g`→g, `_mg`→mg, `_mcg`→mcg) — so if CalorieNinjas adds a
 * nutrient, it flows through automatically rather than being silently dropped. The runner caches
 * the result into `component_nutrients`, so each component is looked up at most once ("resolve
 * once, replay forever"). Requires CALORIENINJAS_API_KEY; select via NUTRITION_STRATEGY=calorieninjas.
 *
 * API: GET https://api.calorieninjas.com/v1/nutrition?query=<food>, header `X-Api-Key: <key>`.
 * CalorieNinjas reports values for `serving_size_g`; we normalize to per-100g.
 */

import type { NutritionStrategy, ReferenceRow } from "./strategies.js";

const CALORIENINJAS_URL = "https://api.calorieninjas.com/v1/nutrition";

/**
 * Fields on the response that are NOT per-serving nutrient amounts and so must be excluded
 * from the dynamic enumeration: the item name and the serving basis we normalize against.
 */
const NON_NUTRIENT_FIELDS = new Set(["name", "serving_size_g"]);

/** Nicer display names for the fields whose raw key humanizes awkwardly; everything else is humanized. */
const DISPLAY_NAMES: Record<string, string> = {
  calories: "Calories",
  protein_g: "Protein",
  carbohydrates_total_g: "Carbs",
  fat_total_g: "Fat",
  fat_saturated_g: "Saturated Fat",
  fiber_g: "Fiber",
  sugar_g: "Sugars",
  sodium_mg: "Sodium",
  potassium_mg: "Potassium",
  cholesterol_mg: "Cholesterol",
};

/** Derive a {unit, kind} from a CalorieNinjas field name by its suffix. `calories` is special. */
function unitAndKind(field: string): { unit: string; kind: "macro" | "micro" } | null {
  if (field === "calories") return { unit: "kcal", kind: "macro" };
  if (field.endsWith("_g")) return { unit: "g", kind: "macro" }; // protein/carbs/fat/fiber/sugar/satfat
  if (field.endsWith("_mg")) return { unit: "mg", kind: "micro" }; // sodium/potassium/cholesterol/…
  if (field.endsWith("_mcg")) return { unit: "mcg", kind: "micro" };
  return null; // not a recognizable nutrient amount → skip
}

/** Humanize a field key into a display name: `fat_saturated_g` → "Fat Saturated". */
function humanize(field: string): string {
  return field
    .replace(/_(g|mg|mcg)$/, "")
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** The CalorieNinjas strategy: no seed; resolve via the live API, taking every nutrient it returns. */
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
    const data = (await resp.json()) as { items?: Record<string, unknown>[] };
    const item = data.items?.[0];
    if (!item) return null;

    // Normalize the returned serving to per-100g (CalorieNinjas defaults to 100g for a bare name).
    const servingG = typeof item.serving_size_g === "number" ? item.serving_size_g : 0;
    const per100 = (v: number) => (servingG > 0 ? (v / servingG) * 100 : v);

    const rows: ReferenceRow[] = [];
    for (const [field, raw] of Object.entries(item)) {
      if (NON_NUTRIENT_FIELDS.has(field)) continue;
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      const uk = unitAndKind(field);
      if (!uk) continue;
      rows.push({
        component,
        nutrient: DISPLAY_NAMES[field] ?? humanize(field),
        kind: uk.kind,
        unit: uk.unit,
        amount_per_100g: per100(raw),
      });
    }
    return rows.length > 0 ? rows : null;
  },
};
