#!/usr/bin/env node
/**
 * cli.ts — Entry point for the nutrition tracker CLI.
 *
 * Commands:
 *   log       --name <str> --component <str:g> [--component ...]
 *   nutrition --meal <id>
 *   meals
 *
 * Run via:  npx tsx src/cli.ts <command> [options]
 */

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { openDb } from "./db.js";
import { seedReferenceData } from "./seed.js";
import { logMeal, getMealNutrition, listMeals } from "./operations.js";

const db = openDb();
seedReferenceData(db);

yargs(hideBin(process.argv))
  .scriptName("nutrition")
  .usage("$0 <command> [options]")

  // ── log ──────────────────────────────────────────────────────────────────
  .command(
    "log",
    "Log a new meal to the Bronze layer",
    (y) =>
      y
        .option("name", {
          type: "string",
          describe: "Meal name",
          demandOption: true,
        })
        .option("component", {
          type: "array",
          describe: 'Component in "name:qty_g" format, e.g. "grilled chicken:150"',
          demandOption: true,
        }),
    (argv) => {
      const rawComponents = argv.component as string[];
      const components = rawComponents.map((raw) => {
        const lastColon = raw.lastIndexOf(":");
        if (lastColon === -1) {
          console.error(`Invalid component format (expected "name:qty_g"): ${raw}`);
          process.exit(1);
        }
        const component = raw.slice(0, lastColon).trim();
        const qty_g = parseFloat(raw.slice(lastColon + 1));
        if (!component || isNaN(qty_g) || qty_g <= 0) {
          console.error(`Invalid component: "${raw}". Format: "name:qty_g"`);
          process.exit(1);
        }
        return { component, qty_g };
      });

      const mealId = logMeal(db, argv.name, components);
      console.log(`Meal logged. id=${mealId}`);
    }
  )

  // ── nutrition ────────────────────────────────────────────────────────────
  .command(
    "nutrition",
    "Show Gold-layer nutrition breakdown for a meal",
    (y) =>
      y.option("meal", {
        type: "string",
        describe: "Meal id",
        demandOption: true,
      }),
    (argv) => {
      const rows = getMealNutrition(db, argv.meal);
      if (rows.length === 0) {
        console.log(
          "No nutrition data found. " +
          "Check the meal id and that all components map to known ingredients."
        );
        return;
      }
      const mealName = rows[0].meal_name;
      console.log(`\nNutrition for: ${mealName}`);
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
      console.log("─".repeat(44));
    }
  )

  // ── meals ────────────────────────────────────────────────────────────────
  .command(
    "meals",
    "List all logged meals",
    () => {},
    () => {
      const meals = listMeals(db);
      if (meals.length === 0) {
        console.log("No meals logged yet.");
        return;
      }
      console.log("\nLogged meals:");
      console.log("─".repeat(72));
      for (const m of meals) {
        const date = new Date(m.eaten_at).toISOString();
        console.log(`  ${m.id}  ${m.name.padEnd(30)}  ${date}`);
      }
      console.log("─".repeat(72));
    }
  )

  .demandCommand(1, "Please specify a command: log | nutrition | meals")
  .help()
  .strict()
  .parse();
