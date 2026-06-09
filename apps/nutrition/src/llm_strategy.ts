/**
 * llm_strategy.ts — an LLM-backed NutritionStrategy (Anthropic claude-opus-4-8).
 *
 * Ported from apps/nutrition/src/llm_source.ts. NO seed: `resolve(component)` asks the
 * model for the comprehensive per-100g nutrient panel of an arbitrary free-text food and
 * maps it into {@link ReferenceRow}s. The runner caches the result into `component_nutrients`,
 * so the (nondeterministic) model is consulted at most once per novel component and every
 * future log replays the cached value ("resolve once, replay forever"). Requires
 * ANTHROPIC_API_KEY; select via NUTRITION_STRATEGY=llm.
 *
 * The Anthropic SDK is imported DYNAMICALLY so the default offline path and the keyless test
 * suite don't need @anthropic-ai/sdk installed; it's only loaded when this strategy resolves.
 */

import type { NutritionStrategy, ReferenceRow } from "./strategies.js";

/** Model id per the claude-api skill (current most-capable Opus). */
const MODEL = "claude-opus-4-8";

// Structured-output schema: an OPEN list of nutrients per 100g (not a fixed five), so the
// model can return the full comprehensive panel, each carrying a display name + kind + unit
// that map straight onto a ReferenceRow.
const NUTRITION_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean", description: "true if this is a recognizable food" },
    nutrients: {
      type: "array",
      description: "the comprehensive nutrient panel for this food, per 100g of edible portion",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: 'display name, e.g. "Protein", "Vitamin B2"' },
          kind: { type: "string", enum: ["macro", "micro"], description: "macro or micro" },
          unit: { type: "string", description: 'unit: "g", "mg", or "mcg"' },
          amount_per_100g: { type: "number", description: "amount per 100g of edible portion" },
        },
        required: ["name", "kind", "unit", "amount_per_100g"],
        additionalProperties: false,
      },
    },
  },
  required: ["found", "nutrients"],
  additionalProperties: false,
} as const;

interface LlmNutrientItem {
  name: string;
  kind: "macro" | "micro";
  unit: string;
  amount_per_100g: number;
}

interface LlmNutrition {
  found: boolean;
  nutrients: LlmNutrientItem[];
}

const SYSTEM_PROMPT =
  "You are a nutrition reference. Given a food or dish name, return the typical " +
  "comprehensive nutrition panel per 100 grams of the edible portion as cooked/served. " +
  "Include macros (protein, carbs, fat, fiber, sugars, saturated fat) and micros (vitamins " +
  "and minerals like iron, calcium, potassium, sodium, magnesium, zinc, vitamin C) wherever " +
  "you can give a realistic estimate — omit a nutrient only when it's truly negligible or " +
  'unknown. Use the canonical names "Protein", "Carbs", "Fat" for the core macros, with the ' +
  "correct kind (macro/micro) and unit (g/mg/mcg). Set found=false only if the input is not a food.";

export const llmStrategy: NutritionStrategy = {
  name: "llm",
  async resolve(component: string): Promise<ReferenceRow[] | null> {
    const key = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
    if (!key) {
      throw new Error("NUTRITION_STRATEGY=llm requires ANTHROPIC_API_KEY to be set.");
    }
    // biome-ignore lint/suspicious/noExplicitAny: SDK is dynamically imported and optional.
    let Anthropic: any;
    try {
      Anthropic = (await import("@anthropic-ai/sdk")).default;
    } catch {
      throw new Error(
        "NUTRITION_STRATEGY=llm requires @anthropic-ai/sdk — run `npm install` in the workspace root.",
      );
    }

    // An OAuth token (sk-ant-oat…) authenticates via `Authorization: Bearer` + the OAuth
    // beta header, NOT via x-api-key — so pass it as `authToken`. A standard API key
    // (sk-ant-api…) uses the default x-api-key path. This lets the strategy work with
    // either credential the environment supplies.
    const isOAuth = key.startsWith("sk-ant-oat");
    const client = isOAuth
      ? new Anthropic({
          // apiKey:null disables the env-derived x-api-key header so ONLY the OAuth
          // Bearer token is sent (sending both x-api-key and Authorization → 401).
          apiKey: null,
          authToken: key,
          defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
        })
      : new Anthropic({ apiKey: key });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: "disabled" }, // fast structured lookup, no reasoning needed
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: NUTRITION_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Food: "${component}"` }],
    });

    // biome-ignore lint/suspicious/noExplicitAny: SDK content blocks are dynamically typed here.
    const block = (response.content as any[]).find((b) => b.type === "text");
    if (!block) return null;
    const data = JSON.parse(block.text) as LlmNutrition;
    if (!data.found) return null;

    const rows: ReferenceRow[] = (data.nutrients ?? [])
      .filter(
        (n) =>
          typeof n?.name === "string" &&
          n.name.trim() !== "" &&
          typeof n.amount_per_100g === "number" &&
          Number.isFinite(n.amount_per_100g),
      )
      .map((n) => ({
        component,
        nutrient: n.name.trim(),
        kind: n.kind === "macro" || n.kind === "micro" ? n.kind : "macro",
        unit: n.unit || "g",
        amount_per_100g: n.amount_per_100g,
      }));
    return rows.length > 0 ? rows : null;
  },
};
