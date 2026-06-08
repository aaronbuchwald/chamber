/**
 * strategies.ts — the strategy pattern for filling the rest of the medallion from a logged meal.
 *
 * `logMeal` writes the Bronze row and then, in the SAME call, resolves each free-text component
 * into Silver/Gold nutrition data using a chosen strategy. A strategy is just a NutritionProvider
 * (an algorithm for turning a component string into per-100g nutrition); swapping the strategy
 * swaps how unknown components get filled, without changing logMeal's orchestration.
 *
 * The set of strategies is the set of options that previously lived behind the separate
 * `enrich_meal` step:
 *   - "local" : no external lookup — rely only on the bundled/seeded reference data (offline).
 *   - "usda"  : USDA FoodData Central lookup (the default).
 *   - "llm"   : LLM estimation for arbitrary dishes.
 */

import type { NutritionProvider } from "./nutrition_source.js";
import { usdaProvider } from "./nutrition_source.js";
import { llmProvider } from "./llm_source.js";

/**
 * The offline strategy: resolves nothing externally, so components fall back to whatever the
 * seeded reference data already covers. This is logMeal's network-free default.
 */
export const localProvider: NutritionProvider = {
  async lookup(): Promise<null> {
    return null;
  },
};

export type StrategyName = "local" | "usda" | "llm";

/** The registry of available strategies (the previously-separate enrichment options). */
export const strategies: Record<StrategyName, NutritionProvider> = {
  local: localProvider,
  usda: usdaProvider,
  llm: llmProvider,
};

/** App-level default when NUTRITION_PROVIDER is unset (matches the prior `enrich_meal` default). */
export const DEFAULT_STRATEGY: StrategyName = "usda";

/** Select a strategy by name, falling back to the default for an unset or unknown value. */
export function selectStrategy(name: string | undefined): NutritionProvider {
  return strategies[name as StrategyName] ?? strategies[DEFAULT_STRATEGY];
}
