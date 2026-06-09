/**
 * llm_source.ts — an LLM-backed NutritionProvider (alternative to the USDA lookup).
 *
 * Same `NutritionProvider` interface as nutrition_source.ts, so it drops straight in as a
 * log_meal strategy — set NUTRITION_PROVIDER=llm to use it (see strategies.ts). Where USDA does
 * an exact database lookup, the LLM *estimates* per-100g nutrition for an arbitrary free-text food
 * (including dishes USDA may not index cleanly), returning structured JSON.
 *
 * Determinism note: the LLM is nondeterministic, but logMeal caches the result into the
 * silver/gold tables keyed by a stable id derived from the food name. So the model is consulted
 * once per novel component; every future log of that component replays the cached value offline
 * ("resolve once, replay forever" — see docs/nutrition-meal-log-design.md §4).
 *
 * The Anthropic SDK is imported *dynamically* so that the default (USDA) path and the test suite
 * don't require @anthropic-ai/sdk to be installed; it's only needed when this provider is used.
 */

import type { NutritionProvider, ProviderNutrient, ProviderResult } from "./nutrition_source.js";

// Structured-output schema: an OPEN list of nutrients per 100g (not a fixed five), so the model
// can return the full comprehensive panel it can estimate. Each nutrient carries id/name/kind/unit
// so fillNutrition auto-registers ones we don't track yet (see nutrition_source.ProviderNutrient).
const NUTRITION_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean", description: "true if this is a recognizable food" },
    canonical_name: { type: "string", description: "normalized food name, lowercase" },
    nutrients: {
      type: "array",
      description: "the comprehensive nutrient panel for this food, per 100g of edible portion",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "stable snake_case id prefixed nut_, e.g. nut_protein, nut_vitb2, nut_calcium. " +
              "Reuse these exact ids for the canonical five: nut_protein, nut_carbs, nut_fat, " +
              "nut_vitc, nut_iron.",
          },
          name: { type: "string", description: 'display name, e.g. "Protein", "Vitamin B2"' },
          kind: { type: "string", enum: ["macro", "micro"], description: "macro or micro" },
          unit: { type: "string", description: 'unit: "g", "mg", or "mcg"' },
          amount_per_100g: { type: "number", description: "amount per 100g of edible portion" },
        },
        required: ["id", "name", "kind", "unit", "amount_per_100g"],
        additionalProperties: false,
      },
    },
  },
  required: ["found", "canonical_name", "nutrients"],
  additionalProperties: false,
} as const;

interface LlmNutrientItem {
  id: string;
  name: string;
  kind: "macro" | "micro";
  unit: string;
  amount_per_100g: number;
}

interface LlmNutrition {
  found: boolean;
  canonical_name: string;
  nutrients: LlmNutrientItem[];
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
        "You are a nutrition reference. Given a food or dish name, return the typical " +
        "comprehensive nutrition panel per 100 grams of the edible portion as cooked/served. " +
        "Include macros (protein, carbs, fat, fiber, sugars, saturated and unsaturated fat) and " +
        "micros (vitamins A, B-complex such as B1/B2/B3/B6/B12 and folate, C, D, E, K; and " +
        "minerals like iron, calcium, potassium, sodium, magnesium, zinc) wherever you can give a " +
        "realistic estimate — omit a nutrient only when it's truly negligible or unknown. Use a " +
        "stable snake_case id prefixed nut_ for each (e.g. nut_protein, nut_vitb2, nut_calcium), " +
        "reusing nut_protein/nut_carbs/nut_fat/nut_vitc/nut_iron for the canonical five, with the " +
        'correct kind (macro/micro) and unit (g/mg/mcg). Set found=false only if the input is not a food.',
      messages: [{ role: "user", content: `Food: "${query}"` }],
    });

    const block = (response.content as any[]).find((b) => b.type === "text");
    if (!block) return null;
    const data = JSON.parse(block.text) as LlmNutrition;
    if (!data.found) return null;

    // Map the open list straight into ProviderNutrient[], carrying metadata so fillNutrition can
    // auto-register any nutrient we don't already track. Skip malformed entries defensively.
    const nutrients: ProviderNutrient[] = (data.nutrients ?? [])
      .filter(
        (n) =>
          typeof n?.id === "string" &&
          n.id.trim() !== "" &&
          typeof n.amount_per_100g === "number" &&
          Number.isFinite(n.amount_per_100g)
      )
      .map((n) => ({
        nutrient_id: n.id,
        amount_per_100g: n.amount_per_100g,
        name: n.name,
        kind: n.kind === "macro" || n.kind === "micro" ? n.kind : undefined,
        unit: n.unit,
      }));

    return {
      canonical_name: (data.canonical_name || query).toLowerCase(),
      external_id: `llm_${slug(query)}`, // deterministic → idempotent caching
      nutrients,
    };
  },
};
