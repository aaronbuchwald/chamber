/**
 * live.test.ts — live integration tests against the REAL CalorieNinjas + Anthropic APIs.
 *
 * These exercise the online strategies end-to-end: log a meal with a real food under each
 * strategy (NO seed present) and assert `nutrition_for` returns plausible non-zero macro
 * totals resolved from the live API. They are KEY-GATED — each skips cleanly when its key is
 * absent, so the default keyless `npm test` / CI stays green. Run them with keys loaded:
 *
 *   npm run test:live    # node --env-file=../../.env --test test/live/*.test.ts
 *
 * Economical: one log per strategy (one API call each), reusing the cached result for reads.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { invokeOperation } from "@chamber/datagram";
import { calorieNinjasStrategy } from "../../src/calorieninjas_strategy.js";
import { llmStrategy } from "../../src/llm_strategy.js";
import { buildNutritionDatagram } from "../../src/service.js";
import type { NutritionStrategy } from "../../src/strategies.js";

async function call(
  app: ReturnType<typeof buildNutritionDatagram>["app"],
  name: string,
  body: unknown,
) {
  const op = app.operations.find((o) => o.name === name);
  assert.ok(op, `operation ${name} exists`);
  const parsed = op.validate(body);
  assert.ok(parsed.ok, `valid args for ${name}`);
  return await invokeOperation(op, parsed.value);
}

/** Log "grilled chicken" under `strategy` (no seed) and assert protein resolved non-zero. */
async function logAndCheckProtein(strategy: NutritionStrategy): Promise<void> {
  const { app, close } = buildNutritionDatagram({ strategy });
  try {
    const { meal_id } = (await call(app, "log_meal", {
      name: "live-test",
      components: [{ component: "grilled chicken", qty_g: 200 }],
    })) as { meal_id: string };
    assert.ok(meal_id, "log_meal returned a meal_id");

    const { nutrition } = (await call(app, "nutrition_for", { meal_id })) as {
      nutrition: Array<{ nutrient: string; kind: string; unit: string; amount: number }>;
    };
    assert.ok(nutrition.length > 0, "live strategy resolved at least one nutrient (no seed)");

    const protein = nutrition.find((r) => r.nutrient === "Protein");
    assert.ok(protein, "Protein resolved from the live API");
    // ~31g/100g chicken × 2 ≈ 62g — accept a wide band, just assert it's plausibly non-zero.
    assert.ok(
      protein.amount > 20 && protein.amount < 120,
      `plausible live protein total for 200g chicken (got ${protein.amount})`,
    );
    assert.equal(protein.kind, "macro");
  } finally {
    close();
  }
}

test(
  "live CalorieNinjas: resolves real macros for grilled chicken (no seed)",
  { skip: !process.env.CALORIENINJAS_API_KEY && "CALORIENINJAS_API_KEY not set" },
  async () => {
    await logAndCheckProtein(calorieNinjasStrategy);
  },
);

test(
  "live LLM (claude-opus-4-8): resolves real macros for grilled chicken (no seed)",
  { skip: !process.env.ANTHROPIC_API_KEY && "ANTHROPIC_API_KEY not set" },
  async () => {
    await logAndCheckProtein(llmStrategy);
  },
);
