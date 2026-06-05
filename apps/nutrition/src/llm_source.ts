/**
 * llm_source.ts — an LLM-backed NutritionProvider (alternative to the USDA lookup).
 *
 * Same `NutritionProvider` interface as nutrition_source.ts, so it drops straight into the
 * `enrich_meal` operation — set NUTRITION_PROVIDER=llm to use it. Where USDA does an exact
 * database lookup, the LLM *estimates* per-100g nutrition for an arbitrary free-text food
 * (including dishes USDA may not index cleanly), returning structured JSON.
 *
 * Determinism note: the LLM is nondeterministic, but enrichMeal caches the result into the
 * silver/gold tables keyed by a stable id derived from the food name. So the model is consulted
 * once per novel component; every future log of that component replays the cached value offline
 * ("resolve once, replay forever" — see docs/nutrition-meal-log-design.md §4).
 *
 * The Anthropic SDK is imported *dynamically* so that the default (USDA) path and the test suite
 * don't require @anthropic-ai/sdk to be installed; it's only needed when this provider is used.
 */

import type { NutritionProvider, ProviderResult } from "./nutrition_source.js";

// Structured-output schema: the 5 nutrients we track, per 100g, plus a found flag.
const NUTRITION_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean", description: "true if this is a recognizable food" },
    canonical_name: { type: "string", description: "normalized food name, lowercase" },
    protein_g_per_100g: { type: "number" },
    carbs_g_per_100g: { type: "number" },
    fat_g_per_100g: { type: "number" },
    vitamin_c_mg_per_100g: { type: "number" },
    iron_mg_per_100g: { type: "number" },
  },
  required: [
    "found",
    "canonical_name",
    "protein_g_per_100g",
    "carbs_g_per_100g",
    "fat_g_per_100g",
    "vitamin_c_mg_per_100g",
    "iron_mg_per_100g",
  ],
  additionalProperties: false,
} as const;

interface LlmNutrition {
  found: boolean;
  canonical_name: string;
  protein_g_per_100g: number;
  carbs_g_per_100g: number;
  fat_g_per_100g: number;
  vitamin_c_mg_per_100g: number;
  iron_mg_per_100g: number;
}

/** Stable slug so the same food maps to the same ingredient id on every lookup. */
function slug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export const llmProvider: NutritionProvider = {
  async lookup(query: string): Promise<ProviderResult | null> {
    // Dynamic import keeps @anthropic-ai/sdk an optional dependency (USDA is the default path).
    let Anthropic: any;
    try {
      Anthropic = (await import("@anthropic-ai/sdk")).default;
    } catch {
      throw new Error(
        "NUTRITION_PROVIDER=llm requires @anthropic-ai/sdk — run `npm install @anthropic-ai/sdk` in apps/nutrition."
      );
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("NUTRITION_PROVIDER=llm requires ANTHROPIC_API_KEY to be set.");
    }

    const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      thinking: { type: "disabled" }, // fast lookup; structured output keeps it terse
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: NUTRITION_SCHEMA },
      },
      system:
        "You are a nutrition reference. Given a food or dish name, return typical nutrition " +
        "per 100 grams of the edible portion as cooked/served. Use realistic average values. " +
        "Set found=false only if the input is not a food.",
      messages: [{ role: "user", content: `Food: "${query}"` }],
    });

    const block = (response.content as any[]).find((b) => b.type === "text");
    if (!block) return null;
    const data = JSON.parse(block.text) as LlmNutrition;
    if (!data.found) return null;

    return {
      canonical_name: (data.canonical_name || query).toLowerCase(),
      external_id: `llm_${slug(query)}`, // deterministic → idempotent caching
      nutrients: [
        { nutrient_id: "nut_protein", amount_per_100g: data.protein_g_per_100g },
        { nutrient_id: "nut_carbs", amount_per_100g: data.carbs_g_per_100g },
        { nutrient_id: "nut_fat", amount_per_100g: data.fat_g_per_100g },
        { nutrient_id: "nut_vitc", amount_per_100g: data.vitamin_c_mg_per_100g },
        { nutrient_id: "nut_iron", amount_per_100g: data.iron_mg_per_100g },
      ],
    };
  },
};
