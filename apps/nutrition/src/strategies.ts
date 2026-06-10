/**
 * strategies.ts — the injectable nutrition strategy seam.
 *
 * A {@link NutritionStrategy} is *how* a meal component gets its per-100g nutrient
 * values. It has two levers:
 *   - `seed`     — reference rows known up front, used to PRE-SEED `component_nutrients`
 *                  when the datagram is built. The offline strategy supplies these.
 *   - `resolve`  — a dynamic, async lookup for a component not already cached. Online
 *                  strategies (CalorieNinjas, LLM) implement this; it runs over the
 *                  network OUTSIDE the per-write transaction (the runner's two-phase
 *                  handler discipline), then the resolved rows are cached into
 *                  `component_nutrients`. "Resolve once, replay forever."
 *
 * Swapping the strategy swaps how `component_nutrients` is populated without
 * touching the data contract (proto) or the Gold view. Offline is the default and
 * stays deterministic and keyless; the online strategies carry NO seed, so when one
 * is active `component_nutrients` is created EMPTY (see service.buildNutritionDatagram).
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Row } from "@chamber/datagram";
import { calorieNinjasStrategy } from "./calorieninjas_strategy.js";
import { llmStrategy } from "./llm_strategy.js";

/**
 * One per-100g reference row: the shape the Gold view joins on. Extends the
 * SDK's {@link Row} (its index signature) so a `ReferenceRow[]` is directly
 * assignable to `ReferenceTable<ReferenceRow>["seed"]` with no bridge cast.
 */
export interface ReferenceRow extends Row {
  component: string;
  nutrient: string;
  kind: string;
  unit: string;
  amount_per_100g: number;
}

/** A pluggable way to populate `component_nutrients` for a meal's components. */
export interface NutritionStrategy {
  /** Stable name (matches NUTRITION_STRATEGY values: offline | calorieninjas | llm). */
  name: string;
  /**
   * Reference rows to PRE-SEED into `component_nutrients` at build time. Offline
   * supplies the bundled seed; online strategies omit this (empty/undefined) so the
   * table starts EMPTY and every component is resolved dynamically.
   */
  seed?: ReferenceRow[];
  /**
   * Dynamic lookup for a component not yet cached. Returns its per-100g rows, or
   * `null` when the strategy can't resolve it (the component just won't contribute
   * nutrition — it does not fail the meal). Async: runs over the network outside the
   * atomic write transaction.
   */
  resolve?(component: string): Promise<ReferenceRow[] | null>;
}

/** Load the bundled offline seed (component → per-100g nutrient rows). */
function loadOfflineSeed(appDir: string): ReferenceRow[] {
  return JSON.parse(
    readFileSync(resolvePath(appDir, "seed/component_nutrients.json"), "utf8"),
  ) as ReferenceRow[];
}

/**
 * The offline (default) strategy. Pre-seeds the bundled reference matrix and does
 * NOT resolve anything dynamically — components fall back to whatever the seed
 * covers. Fully deterministic and keyless. `appDir` is the app root (parent of src/).
 */
export function offlineStrategy(appDir: string): NutritionStrategy {
  return { name: "offline", seed: loadOfflineSeed(appDir) };
}

/** The strategy names selectable via the NUTRITION_STRATEGY env var. */
export type StrategyName = "offline" | "calorieninjas" | "llm";

/**
 * Select a strategy by name for the HTTP / MCP / CLI entry points. Defaults to
 * offline (deterministic, keyless) for an unset or unknown value. The online
 * strategies carry no seed, so selecting one makes `component_nutrients` start empty.
 * `appDir` is the app root, used by the offline strategy to load its seed.
 */
export function selectStrategy(name: string | undefined, appDir: string): NutritionStrategy {
  switch (name) {
    case "calorieninjas":
      return calorieNinjasStrategy;
    case "llm":
      return llmStrategy;
    default:
      return offlineStrategy(appDir);
  }
}
