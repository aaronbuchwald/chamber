/**
 * cases.ts — the editable eval case list for the nutrition resolution strategies.
 *
 * ADDING / EDITING A CASE IS A ONE-FILE CHANGE: append (or edit) one `EvalCase` object in the
 * `cases` array below. Nothing else needs to change — the runner (runner.ts) and the test
 * entrypoint (../eval.test.ts) discover cases from this list automatically.
 *
 * Each case pins:
 *   - a `strategy` (local / usda / calorieninjas / llm — see ../../src/strategies.ts), and
 *   - a `mode` of judging:
 *       "deterministic" — assert per-nutrient amounts are within numeric tolerances, OR
 *       "llm-judge"     — score the actual nutrition output against a rubric via an LLM.
 *
 * REPRODUCIBILITY: network strategies (usda / calorieninjas / llm) must NOT hit the network in
 * deterministic mode. For those, set `fakeProvider` to a stub `NutritionProvider` that returns a
 * fixed result, so the case is fully offline and reproducible. Cases that exercise the real LLM
 * use mode "llm-judge" and are SKIPPED cleanly when ANTHROPIC_API_KEY / @anthropic-ai/sdk is absent.
 *
 * COORDINATION (task chamber-tfp.3): `expected[]` is keyed by `nutrient_id` (not display name), so
 * adding new nutrients to the schema later does not break existing cases — an unlisted nutrient is
 * simply not asserted.
 *
 * Seed reference values (per 100g, from ../../data/ingredient_nutrients.csv):
 *   grilled chicken — protein 31,  carbs 0,  fat 3.6, vitc 0,    iron 1
 *   brown rice      — protein 2.6, carbs 23, fat 0.9, vitc 0,    iron 0.5
 *   broccoli        — protein 2.8, carbs 6.6,fat 0.4, vitc 89.2, iron 0.7
 *   egg             — protein 13,  carbs 1.1,fat 11,  vitc 0,    iron 1.8
 */

import type { ComponentSpec } from "../../src/operations.js";
import type { StrategyName } from "../../src/strategies.js";
import type { NutritionProvider } from "../../src/nutrition_source.js";

export interface EvalCase {
  /** Stable, human-readable id; used as the test name. */
  id: string;
  /** The meal input. Cases supply explicit `components` (the meal parser is out of scope here). */
  input: { description?: string; components?: ComponentSpec[] };
  /** Which strategy produced / should produce the output (see ../../src/strategies.ts). */
  strategy: StrategyName;
  /** How this case is judged. */
  mode: "deterministic" | "llm-judge";
  /** deterministic: expected per-nutrient amounts (keyed by nutrient_id) with tolerances. */
  expected?: { nutrient_id: string; amount: number; tol: number }[];
  /** llm-judge: a rubric the judge scores the actual nutrition output against (score in [0, 1]). */
  rubric?: { criteria: string; min_score: number };
  /**
   * Offline stub for network strategies (usda / calorieninjas / llm) in deterministic mode.
   * When set, the runner uses this instead of the real strategy provider — keeps the case
   * reproducible and network-free.
   */
  fakeProvider?: NutritionProvider;
}

export const cases: EvalCase[] = [
  // 1) Seeded local single component (deterministic, offline).
  //    150g grilled chicken → protein 150*31/100 = 46.5g, fat 150*3.6/100 = 5.4g.
  {
    id: "local-single-grilled-chicken",
    input: { components: [{ component: "grilled chicken", qty_g: 150 }] },
    strategy: "local",
    mode: "deterministic",
    expected: [
      { nutrient_id: "nut_protein", amount: 46.5, tol: 0.01 },
      { nutrient_id: "nut_fat", amount: 5.4, tol: 0.01 },
    ],
  },

  // 2) Multi-component meal sum (deterministic, offline).
  //    100g grilled chicken + 200g brown rice:
  //    protein = 31 + 2*2.6 = 36.2g; carbs = 0 + 2*23 = 46g.
  {
    id: "local-multi-chicken-rice-sum",
    input: {
      components: [
        { component: "grilled chicken", qty_g: 100 },
        { component: "brown rice", qty_g: 200 },
      ],
    },
    strategy: "local",
    mode: "deterministic",
    expected: [
      { nutrient_id: "nut_protein", amount: 36.2, tol: 0.05 },
      { nutrient_id: "nut_carbs", amount: 46, tol: 0.05 },
    ],
  },

  // 3) USDA-style lookup via a FAKE provider (deterministic, offline & reproducible).
  //    "unicorn meat" is not in the seed data, so the strategy is consulted; the stub returns
  //    a fixed per-100g profile. 100g → protein 20g, fat 10g.
  {
    id: "usda-fake-unicorn-meat",
    input: { components: [{ component: "unicorn meat", qty_g: 100 }] },
    strategy: "usda",
    mode: "deterministic",
    fakeProvider: {
      async lookup(query: string) {
        if (query !== "unicorn meat") return null;
        return {
          canonical_name: "unicorn meat",
          external_id: "fake-usda-1",
          nutrients: [
            { nutrient_id: "nut_protein", amount_per_100g: 20 },
            { nutrient_id: "nut_carbs", amount_per_100g: 0 },
            { nutrient_id: "nut_fat", amount_per_100g: 10 },
            { nutrient_id: "nut_vitc", amount_per_100g: 0 },
            { nutrient_id: "nut_iron", amount_per_100g: 3 },
          ],
        };
      },
    },
    expected: [
      { nutrient_id: "nut_protein", amount: 20, tol: 0.01 },
      { nutrient_id: "nut_fat", amount: 10, tol: 0.01 },
    ],
  },

  // 4) CalorieNinjas-style macros-only lookup via a FAKE provider (deterministic, offline).
  //    Micros (vit C / iron) are reported as 0 — mirrors the real CalorieNinjas limitation.
  //    150g "dragon steak" → protein 30g, carbs 0g, fat 12g, vitc 0, iron 0.
  {
    id: "calorieninjas-fake-dragon-steak-macros-only",
    input: { components: [{ component: "dragon steak", qty_g: 150 }] },
    strategy: "calorieninjas",
    mode: "deterministic",
    fakeProvider: {
      async lookup(query: string) {
        if (query !== "dragon steak") return null;
        return {
          canonical_name: "dragon steak",
          external_id: "fake-cn-1",
          nutrients: [
            { nutrient_id: "nut_protein", amount_per_100g: 20 },
            { nutrient_id: "nut_carbs", amount_per_100g: 0 },
            { nutrient_id: "nut_fat", amount_per_100g: 8 },
            { nutrient_id: "nut_vitc", amount_per_100g: 0 },
            { nutrient_id: "nut_iron", amount_per_100g: 0 },
          ],
        };
      },
    },
    expected: [
      { nutrient_id: "nut_protein", amount: 30, tol: 0.01 },
      { nutrient_id: "nut_fat", amount: 12, tol: 0.01 },
      { nutrient_id: "nut_vitc", amount: 0, tol: 0.0001 },
      { nutrient_id: "nut_iron", amount: 0, tol: 0.0001 },
    ],
  },

  // 5) LLM estimation judged by a rubric (llm-judge).
  //    SKIPPED cleanly offline (no ANTHROPIC_API_KEY / no @anthropic-ai/sdk). When a key is
  //    present, the real LLM strategy estimates 100g grilled chicken and the judge scores it.
  {
    id: "llm-grilled-chicken-rubric",
    input: { components: [{ component: "grilled chicken", qty_g: 100 }] },
    strategy: "llm",
    mode: "llm-judge",
    rubric: {
      criteria:
        "The reported protein for 100g of grilled chicken should be a realistic value between " +
        "20 and 40 grams, and fat should be positive.",
      min_score: 0.7,
    },
  },

  // 6) Edge case — unknown food, graceful zero / unresolved (deterministic, offline).
  //    The "local" strategy resolves nothing externally and the food is not seeded, so the Gold
  //    view yields NO rows for this meal. The runner's rule "expected amount 0 + absent row =>
  //    pass" verifies this graceful-unresolved behavior (no crash, no spurious nutrition).
  {
    id: "local-unknown-food-graceful-zero",
    input: { components: [{ component: "nonexistent mystery food", qty_g: 100 }] },
    strategy: "local",
    mode: "deterministic",
    expected: [{ nutrient_id: "nut_protein", amount: 0, tol: 0 }],
  },
];
