/**
 * calorieninjas.test.ts — the CalorieNinjas strategy's per-100g normalization, keyless.
 *
 * Stubs global `fetch` (and the API key) so these run in default CI without a real
 * key or network. The focus is the serving-size guard: a non-positive or
 * non-numeric `serving_size_g` makes the per-100g scale undefined, so the strategy
 * must return `null` (the component contributes nothing) rather than caching raw
 * per-serving values mislabeled as per-100g — a mistake "resolve once" would make
 * permanent.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { calorieNinjasStrategy } from "../src/calorieninjas_strategy.js";

const realFetch = globalThis.fetch;
const realKey = process.env.CALORIENINJAS_API_KEY;

/** Stub `fetch` to return one CalorieNinjas item verbatim. */
function stubFetch(item: Record<string, unknown> | null): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ items: item ? [item] : [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

beforeEach(() => {
  process.env.CALORIENINJAS_API_KEY = "test-key";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  // Restore the original key state. Assigning `undefined` to a process.env entry
  // coerces to the string "undefined", so clear via Reflect.deleteProperty when
  // there was no key to begin with (keeps the offline suite truly keyless).
  if (realKey === undefined) Reflect.deleteProperty(process.env, "CALORIENINJAS_API_KEY");
  else process.env.CALORIENINJAS_API_KEY = realKey;
});

test("normalizes a positive serving_size_g to per-100g", async () => {
  // 200g serving with 40g protein → 20g per 100g.
  stubFetch({ name: "chicken", serving_size_g: 200, protein_g: 40, calories: 330 });
  const rows = await calorieNinjasStrategy.resolve?.("chicken");
  assert.ok(rows, "resolved rows for a valid serving size");
  const protein = rows.find((r) => r.nutrient === "Protein");
  assert.ok(protein);
  assert.ok(Math.abs(protein.amount_per_100g - 20) < 1e-9, "40g/200g × 100 = 20g per 100g");
});

test("serving_size_g <= 0 is unresolvable → returns null (no raw values cached as per-100g)", async () => {
  stubFetch({ name: "mystery", serving_size_g: 0, protein_g: 40, calories: 330 });
  const rows = await calorieNinjasStrategy.resolve?.("mystery");
  assert.equal(rows, null, "serving_size_g === 0 → null, not raw per-serving values");
});

test("negative serving_size_g is unresolvable → returns null", async () => {
  stubFetch({ name: "weird", serving_size_g: -5, protein_g: 10 });
  const rows = await calorieNinjasStrategy.resolve?.("weird");
  assert.equal(rows, null, "negative serving size → null");
});

test("non-numeric serving_size_g is unresolvable → returns null", async () => {
  stubFetch({ name: "weird", serving_size_g: "100", protein_g: 10 });
  const rows = await calorieNinjasStrategy.resolve?.("weird");
  assert.equal(rows, null, "non-numeric serving size → null");
});
