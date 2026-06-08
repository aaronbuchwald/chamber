/**
 * meal_parser.ts — turn a free-text meal description into its components + portions.
 *
 * This is the step that lets a user log a meal by typing what they ate in plain language
 * ("sausage egg and cheese everything bagel") instead of hand-entering each component and its
 * gram weight. A MealParser decomposes the description into ComponentSpec[] (a food + estimated
 * edible grams for one serving); logMeal then resolves each component's per-100g nutrition via the
 * separate NutritionProvider strategy (see strategies.ts). The two concerns are orthogonal:
 *   parser  : description            -> [{ component, qty_g }, ...]   (portion estimation)
 *   strategy: component              -> per-100g nutrition            (nutrient lookup)
 *
 * Caching note: unlike per-100g nutrition (cached "resolve once, replay forever" because it's a
 * property of an ingredient), a parse is a property of a specific eating occasion — each logged
 * meal is its own event — so parses are intentionally NOT cached and run per log.
 *
 * The Anthropic SDK is imported *dynamically* (as in llm_source.ts) so the offline/default paths
 * and the test suite don't require @anthropic-ai/sdk; it's only loaded when the LLM parser runs.
 */

import type { ComponentSpec } from "./operations.js";
import { fetchCalorieNinjasItems } from "./calorieninjas_source.js";

export interface MealParser {
  /** Break a free-text meal description into its component foods + estimated grams per serving. */
  parse(description: string): Promise<ComponentSpec[]>;
}

// Structured-output schema: the list of foods that make up the described meal.
const MEAL_PARSE_SCHEMA = {
  type: "object",
  properties: {
    components: {
      type: "array",
      description: "the distinct foods that make up the described meal",
      items: {
        type: "object",
        properties: {
          component: {
            type: "string",
            description:
              "a single food, lowercase, e.g. 'fried egg', 'everything bagel', 'cheddar cheese'",
          },
          qty_g: {
            type: "number",
            description: "estimated edible grams of this food eaten in one serving of the meal",
          },
        },
        required: ["component", "qty_g"],
        additionalProperties: false,
      },
    },
  },
  required: ["components"],
  additionalProperties: false,
} as const;

interface ParsedMeal {
  components: { component: string; qty_g: number }[];
}

/**
 * The default parser: an LLM decomposes the description into foods and estimates a realistic
 * portion (grams) for each, assuming one typical serving unless the text says otherwise. Requires
 * ANTHROPIC_API_KEY and @anthropic-ai/sdk (the same dependency llm_source.ts uses).
 */
export const llmMealParser: MealParser = {
  async parse(description: string): Promise<ComponentSpec[]> {
    let Anthropic: any;
    try {
      Anthropic = (await import("@anthropic-ai/sdk")).default;
    } catch {
      throw new Error(
        "Parsing a free-text meal requires @anthropic-ai/sdk — run `npm install @anthropic-ai/sdk` in apps/nutrition, " +
          "or pass explicit `components` (or set MEAL_PARSER=passthrough)."
      );
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "Parsing a free-text meal requires ANTHROPIC_API_KEY — set it, pass explicit `components`, or set MEAL_PARSER=passthrough."
      );
    }

    const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      thinking: { type: "disabled" }, // fast decomposition; structured output keeps it terse
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: MEAL_PARSE_SCHEMA },
      },
      system:
        "You break a described meal into the individual foods a person eats and estimate how many " +
        "grams of each they eat in ONE serving of what's described. Assume a single typical serving " +
        "unless the text gives a quantity (e.g. '2 bagels', 'a large bowl'). Split composite dishes " +
        "into their parts — e.g. 'sausage egg and cheese everything bagel' becomes an everything " +
        "bagel, a sausage patty, a fried egg, and a slice of cheese. Use realistic cooked/as-served " +
        "edible gram weights. Name each component as a plain, lookup-friendly food name.",
      messages: [{ role: "user", content: `Meal: "${description}"` }],
    });

    const block = (response.content as any[]).find((b) => b.type === "text");
    if (!block) return [];
    const data = JSON.parse(block.text) as ParsedMeal;
    // Keep only well-formed, positive-weight components.
    return (data.components ?? [])
      .map((c) => ({ component: String(c.component ?? "").trim(), qty_g: Number(c.qty_g) }))
      .filter((c) => c.component !== "" && Number.isFinite(c.qty_g) && c.qty_g > 0);
  },
};

/**
 * CalorieNinjas decomposition (no LLM needed): CalorieNinjas natively splits a free-text food
 * string into one item per food, so we use those items directly as the meal's components, taking
 * each item's serving_size_g as its portion. Requires only CALORIENINJAS_API_KEY — the same key the
 * CalorieNinjas nutrition strategy uses — so a CalorieNinjas setup needs no Anthropic key.
 *
 * Portion note: for a bare food name CalorieNinjas reports serving_size_g = 100, so portions
 * default to 100g per item unless the description carries explicit quantities; the LLM parser
 * (MEAL_PARSER=llm) is the option that estimates realistic single-serving portions.
 */
export const calorieNinjasMealParser: MealParser = {
  async parse(description: string): Promise<ComponentSpec[]> {
    const items = await fetchCalorieNinjasItems(description);
    return items
      .map((it) => ({
        component: String(it.name ?? "").trim(),
        qty_g: it.serving_size_g > 0 ? it.serving_size_g : 100,
      }))
      .filter((c) => c.component !== "" && Number.isFinite(c.qty_g) && c.qty_g > 0);
  },
};

/**
 * Offline fallback: treat the whole description as a single 100g component. No network, no LLM —
 * useful for tests and air-gapped runs (set MEAL_PARSER=passthrough). Nutrition for that component
 * is then whatever the configured strategy/seed data resolves.
 */
export const passthroughMealParser: MealParser = {
  async parse(description: string): Promise<ComponentSpec[]> {
    const name = description.trim();
    return name ? [{ component: name, qty_g: 100 }] : [];
  },
};

export type ParserName = "llm" | "calorieninjas" | "passthrough";

export const parsers: Record<ParserName, MealParser> = {
  llm: llmMealParser,
  calorieninjas: calorieNinjasMealParser,
  passthrough: passthroughMealParser,
};

/**
 * Select a parser. An explicit MEAL_PARSER wins; otherwise we pick a default that won't crash on a
 * missing Anthropic key: CalorieNinjas decomposition when CALORIENINJAS_API_KEY is present (it
 * already powers the nutrition lookups), else the fully-offline passthrough. The LLM parser is
 * opt-in via MEAL_PARSER=llm.
 */
export function selectParser(name: string | undefined): MealParser {
  if (name && name in parsers) return parsers[name as ParserName];
  if (process.env.CALORIENINJAS_API_KEY) return calorieNinjasMealParser;
  return passthroughMealParser;
}
