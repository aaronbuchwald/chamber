#!/usr/bin/env node
/**
 * demo.ts — Runs a self-contained demonstration of the nutrition tracker.
 *
 * 1. Opens (or creates) the DB and seeds reference data (idempotent).
 * 2. Logs two sample meals.
 * 3. Prints the nutrition breakdown for each from the Gold view.
 * 4. Lists all logged meals.
 *
 * Run:  npm run demo
 *   or: npx tsx src/demo.ts
 */

import { openDb } from "./db.js";
import { seedReferenceData } from "./seed.js";
import { logMeal, getMealNutrition, listMeals } from "./operations.js";

const db = openDb();
seedReferenceData(db);

// ── Print nutrition for each meal ────────────────────────────────────────
function printNutrition(mealId: string): void {
  const rows = getMealNutrition(db, mealId);
  if (rows.length === 0) {
    console.log(`  (no nutrition data for ${mealId})\n`);
    return;
  }
  console.log(`Nutrition for: ${rows[0].meal_name}`);
  console.log("─".repeat(44));
  console.log(
    "Nutrient".padEnd(14),
    "Kind ".padEnd(7),
    "Amount".padStart(9),
    "Unit"
  );
  console.log("─".repeat(44));
  for (const r of rows) {
    console.log(
      r.nutrient.padEnd(14),
      r.nutrient_kind.padEnd(7),
      r.amount.toFixed(1).padStart(9),
      r.unit
    );
  }
  console.log("─".repeat(44) + "\n");
}

// logMeal now resolves nutrition in the same call, so it's async — run the demo in an async main
// (this project transpiles to CJS via tsx, where top-level await isn't available).
async function main(): Promise<void> {
  console.log("=== Chamber Nutrition Tracker — Demo ===\n");
  console.log("SQLite library: better-sqlite3 (native)\n");

  // ── Log meal 1: Chicken burrito bowl ─────────────────────────────────────
  const meal1Id = await logMeal(db, "Chicken burrito bowl", [
    { component: "grilled chicken", qty_g: 150 },
    { component: "brown rice",      qty_g: 200 },
    { component: "olive oil",       qty_g:  10 },
    { component: "broccoli",        qty_g: 100 },
  ]);
  console.log(`Logged "Chicken burrito bowl"  → id=${meal1Id}`);

  // ── Log meal 2: Breakfast oats ────────────────────────────────────────────
  const meal2Id = await logMeal(db, "Breakfast oats", [
    { component: "rolled oats",     qty_g:  80 },
    { component: "scrambled eggs",  qty_g: 100 },
  ]);
  console.log(`Logged "Breakfast oats"        → id=${meal2Id}\n`);

  printNutrition(meal1Id);
  printNutrition(meal2Id);

  // ── List all logged meals ─────────────────────────────────────────────────
  const meals = listMeals(db);
  console.log("All logged meals:");
  console.log("─".repeat(72));
  for (const m of meals) {
    const date = new Date(m.eaten_at).toISOString();
    console.log(`  ${m.id}  ${m.name.padEnd(30)}  ${date}`);
  }
  console.log("─".repeat(72));

  db.close();
}

main();
