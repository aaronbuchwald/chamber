/**
 * service.ts — the nutrition datagram assembled on @chamber/datagram.
 *
 * Wires the proto NutritionService to three handlers over the typed string-free
 * data handle, derives the SQLite schema from the proto descriptors + the seeded
 * reference table, and produces the runtime operations + app definition the
 * HTTP / MCP / CLI entry points serve.
 *
 * The handlers NEVER write SQL: they name tables/columns and pass values; the
 * SDK binds params and allowlists identifiers. The single-point access guard and
 * the per-write atomic transaction live in the SDK's runner, not here.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AppDef,
  type Handlers,
  type ReferenceTable,
  type Summaries,
  defineApp,
  deriveSchema,
  openSqlite,
  protoToOperations,
} from "@chamber/datagram";
import type {
  ListMealsRequest,
  LogMealRequest,
  NutritionForRequest,
} from "@chamber/datagram/gen/nutrition/v1/nutrition_pb";
import { NutritionService } from "@chamber/datagram/gen/nutrition/v1/nutrition_pb";

/** The app root (parent of src/), used to resolve seed + transform files. */
export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface ComponentNutrientRow {
  component: string;
  nutrient: string;
  kind: string;
  unit: string;
  amount_per_100g: number;
}

/** The seeded reference matrix: component → per-100g amount of each nutrient. */
export function referenceTable(): ReferenceTable {
  const seed = JSON.parse(
    readFileSync(resolve(APP_DIR, "seed/component_nutrients.json"), "utf8"),
  ) as ComponentNutrientRow[];
  return {
    kind: "reference",
    name: "component_nutrients",
    columns: [
      { name: "component", affinity: "TEXT", primaryKey: false },
      { name: "nutrient", affinity: "TEXT", primaryKey: false },
      { name: "kind", affinity: "TEXT", primaryKey: false },
      { name: "unit", affinity: "TEXT", primaryKey: false },
      { name: "amount_per_100g", affinity: "REAL", primaryKey: false },
    ],
    primaryKey: ["component", "nutrient"],
    seed: seed as unknown as ReferenceTable["seed"],
  };
}

/** One parsed component of a meal: a food name + estimated edible grams. */
interface ComponentSpec {
  component: string;
  qty_g: number;
}

/**
 * Offline meal parsing (v0 is offline — no LLM / external lookup). Explicit
 * `components` win; otherwise the whole description is treated as a single 100g
 * component (the passthrough path ported from the original app). Nutrition for a
 * component is then whatever the seeded reference data covers.
 */
function parseMeal(req: LogMealRequest): { name: string; components: ComponentSpec[] } {
  const name = (req.name || req.description || "meal").trim();
  if (req.components.length > 0) {
    const components = req.components
      .map((c) => ({ component: c.component.trim(), qty_g: c.qtyG }))
      .filter((c) => c.component !== "" && Number.isFinite(c.qty_g) && c.qty_g > 0);
    return { name, components };
  }
  const desc = req.description.trim();
  return { name, components: desc ? [{ component: desc, qty_g: 100 }] : [] };
}

/** Options for assembling the datagram (lets tests pin an in-memory DB / read-only flip). */
export interface BuildOptions {
  /** SQLite path; defaults to an in-memory DB. */
  dbPath?: string;
  /** Override the service descriptor (tests flip access to READ_WRITE/READ). */
  service?: typeof NutritionService;
}

/** The assembled nutrition datagram: its app definition plus a close() handle. */
export interface NutritionDatagram {
  app: AppDef;
  close: () => void;
}

const SUMMARIES: Summaries = {
  logMeal: "Log a meal (parsed into components offline) and its eaten-at time",
  nutritionFor: "Macro/micro nutrient totals for a meal, from the Gold view",
  listMeals: "List logged meals, most recent first",
};

/**
 * Build the nutrition datagram. Derives the schema, opens the backend, registers
 * the three handlers, and returns the runtime app definition.
 */
export function buildNutritionDatagram(opts: BuildOptions = {}): NutritionDatagram {
  const service = opts.service ?? NutritionService;
  const schema = deriveSchema(service, [referenceTable()]);
  const backend = openSqlite(schema, {
    path: opts.dbPath ?? ":memory:",
    transformDir: APP_DIR,
  });

  const handlers: Handlers = {
    logMeal: (req, { data }) => {
      const r = req as LogMealRequest;
      const { name, components } = parseMeal(r);
      const mealId = randomUUID();
      const eatenAt = r.eatenAt !== 0n ? Number(r.eatenAt) : Date.now();
      data.insert("meals", { id: mealId, name, eaten_at: eatenAt });
      for (const c of components) {
        data.insert("meal_components", {
          id: randomUUID(),
          meal_id: mealId,
          component: c.component,
          qty_g: c.qty_g,
        });
      }
      return { meal_id: mealId };
    },

    nutritionFor: (req, { data }) => {
      const r = req as NutritionForRequest;
      const nutrition = data.query("gold_meal_nutrition", { eq: ["meal_id", r.mealId] });
      return { nutrition };
    },

    listMeals: (_req, { data }) => {
      void (_req as ListMealsRequest);
      const meals = data.query("meals", { orderBy: ["eaten_at", "desc"] });
      return { meals };
    },
  };

  const operations = protoToOperations(service, backend, handlers, SUMMARIES);
  const app = defineApp({ name: "nutrition-dg", version: "0.0.0", operations });
  return { app, close: () => backend.close() };
}
