/**
 * cli.ts — run the nutrition datagram's actions from the command line.
 *
 *   nutrition-dg log_meal --description "oatmeal" --eaten_at 1700000000000
 *   nutrition-dg list_meals
 *   nutrition-dg nutrition_for --meal_id <id>
 */

import { runCli } from "@chamber/datagram";
import { buildNutritionDatagram } from "./service.js";

const { app } = buildNutritionDatagram({ dbPath: process.env.DB_PATH ?? "nutrition-dg.db" });
runCli(app, process.argv.slice(2));
