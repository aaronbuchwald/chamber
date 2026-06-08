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
import { logMeal, getMealNutrition, listMeals, type ComponentSpec } from "./operations.js";
import { selectStrategy } from "./strategies.js";
import { selectParser } from "./meal_parser.js";

const db = openDb();
seedReferenceData(db);

// Strategy that fills nutrition for unknown components as part of log_meal (see strategies.ts).
// USDA is the deterministic default; NUTRITION_PROVIDER=llm estimates via an LLM, and
// NUTRITION_PROVIDER=local stays fully offline (seeded reference data only).
const strategy = selectStrategy(process.env.NUTRITION_PROVIDER);

// Parser that turns a free-text meal description into components + portions (see meal_parser.ts),
// so a user can log "sausage egg and cheese everything bagel" without hand-entering components.
// Default needs no Anthropic key: CalorieNinjas decomposition when CALORIENINJAS_API_KEY is set,
// else offline passthrough. MEAL_PARSER=llm opts into LLM portion estimation.
const parser = selectParser(process.env.MEAL_PARSER);

/** A component is "name:grams" (CLI-friendly) OR {component, qty_g} (JSON clients). */
const component = z.union([
  z.string().transform((s, ctx) => {
    const i = s.lastIndexOf(":");
    const name = i === -1 ? s.trim() : s.slice(0, i).trim();
    const qty_g = i === -1 ? NaN : parseFloat(s.slice(i + 1));
    if (!name || Number.isNaN(qty_g) || !isFinite(qty_g) || qty_g <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Expected "name:grams", got "${s}"` });
      return z.NEVER;
    }
    return { component: name, qty_g };
  }),
  z.object({ component: z.string(), qty_g: z.number().finite().positive() }),
]);

export const app = defineApp({
  name: "nutrition",
  version: "0.1.0",
  operations: [
    {
      name: "log_meal",
      summary:
        "Log a meal from a free-text description and resolve its nutrition end-to-end (Bronze → Silver → " +
        "Gold) in one call. Components and portions are estimated from the description by the configured " +
        "parser (pass explicit `components` to skip estimation); unknown components are then filled from " +
        "the configured strategy (USDA/CalorieNinjas/LLM/local).",
      input: z.object({
        description: z
          .string()
          .optional()
          .describe(
            "Free-text meal, e.g. 'sausage egg and cheese everything bagel'. Components and portions are estimated automatically."
          ),
        name: z.string().optional().describe("Explicit meal name (optional; defaults to the description)."),
        components: arrayOf(component)
          .optional()
          .describe('Optional explicit components as "name:grams" or {component, qty_g}; skips estimation when given.'),
      }),
      handler: async ({ description, name, components }) => {
        let comps: ComponentSpec[] = components ?? [];
        if (comps.length === 0) {
          if (!description) throw new Error("Provide a `description` (or explicit `components`).");
          comps = await parser.parse(description);
          if (comps.length === 0) throw new Error(`Could not identify any foods in "${description}".`);
        }
        const mealName = name ?? description;
        if (!mealName) throw new Error("Provide a `name` or a `description`.");
        return { meal_id: await logMeal(db, mealName, comps, strategy) };
      },
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
