/**
 * app.ts — the nutrition app's operation registry (single source of truth).
 *
 * These three operations are declared once (name + zod input + handler over the
 * existing core in operations.ts) and are served identically as a CLI, an
 * HTTP+OpenAPI API, and an MCP server via @chamber/appkit. This is the concrete
 * draft of the Chamber `server` interface (init()->tools + call-tool).
 */
import { defineApp, z, arrayOf } from "../../../packages/appkit/src/index.js";
import { openDb } from "./db.js";
import { seedReferenceData } from "./seed.js";
import { logMeal, getMealNutrition, listMeals } from "./operations.js";

const db = openDb();
seedReferenceData(db);

/** A component is "name:grams" (CLI-friendly) OR {component, qty_g} (JSON clients). */
const component = z.union([
  z.string().transform((s, ctx) => {
    const i = s.lastIndexOf(":");
    const name = i === -1 ? s.trim() : s.slice(0, i).trim();
    const qty_g = i === -1 ? NaN : parseFloat(s.slice(i + 1));
    if (!name || Number.isNaN(qty_g) || qty_g <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Expected "name:grams", got "${s}"` });
      return z.NEVER;
    }
    return { component: name, qty_g };
  }),
  z.object({ component: z.string(), qty_g: z.number().positive() }),
]);

export const app = defineApp({
  name: "nutrition",
  version: "0.1.0",
  operations: [
    {
      name: "log_meal",
      summary: "Log a meal (Bronze layer) with its components.",
      input: z.object({
        name: z.string().describe("Meal name, e.g. 'Chicken burrito bowl'"),
        components: arrayOf(component).describe('Components as "name:grams" or {component, qty_g}'),
      }),
      handler: ({ name, components }) => ({ meal_id: logMeal(db, name, components) }),
    },
    {
      name: "nutrition_for",
      summary: "Macro + micro nutrient totals for a meal (Gold view).",
      input: z.object({ meal_id: z.string().describe("Meal id returned by log_meal") }),
      handler: ({ meal_id }) => getMealNutrition(db, meal_id),
    },
    {
      name: "list_meals",
      summary: "List all logged meals, newest first.",
      input: z.object({}),
      handler: () => listMeals(db),
    },
  ],
});
