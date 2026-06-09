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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@bufbuild/protobuf";
import {
  type AppDef,
  type Handlers,
  type PreparedHandler,
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
} from "@chamber/proto/nutrition/v1/nutrition_pb";
import { NutritionService } from "@chamber/proto/nutrition/v1/nutrition_pb";
import { type NutritionStrategy, type ReferenceRow, offlineStrategy } from "./strategies.js";

/** The app root (parent of src/), used to resolve seed + transform files. */
export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The reference matrix DDL: component → per-100g amount of each nutrient. Its seed
 * comes from the active {@link NutritionStrategy} (`strategy.seed ?? []`): offline
 * supplies the bundled rows; online strategies supply none, so the table is created
 * EMPTY and every component is resolved dynamically on first use.
 */
export function referenceTable(seed: ReferenceRow[] = []): ReferenceTable<ReferenceRow> {
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
    seed,
  };
}

/** One parsed component of a meal: a food name + estimated edible grams. */
interface ComponentSpec {
  component: string;
  qty_g: number;
}

/**
 * Meal parsing. Explicit `components` win; otherwise the whole description is
 * treated as a single 100g component (the passthrough path ported from the
 * original app). Nutrition for a component is then whatever the active strategy
 * supplies — the offline seed, or a dynamic resolution (CalorieNinjas / LLM).
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
  /**
   * How a component's nutrient values are populated. Defaults to {@link offlineStrategy}
   * (deterministic, keyless, pre-seeded). An online strategy (CalorieNinjas / LLM) carries
   * no seed, so `component_nutrients` starts EMPTY and is filled by `resolve` on first use.
   */
  strategy?: NutritionStrategy;
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
  const strategy = opts.strategy ?? offlineStrategy(APP_DIR);
  // HARD INVARIANT: the reference table is seeded ONLY from the strategy. An online
  // strategy supplies no seed, so `component_nutrients` is created EMPTY — the offline
  // seed JSON is never loaded on that path.
  const schema = deriveSchema(service, [referenceTable(strategy.seed ?? [])]);
  const backend = openSqlite(schema, {
    path: opts.dbPath ?? ":memory:",
    transformDir: APP_DIR,
  });

  /** What the async prepare phase resolved for the synchronous commit. */
  interface LoggedMeal {
    name: string;
    eatenAt: number;
    components: ComponentSpec[];
    /** Newly-resolved reference rows to cache (empty for the offline strategy). */
    newRows: ReferenceRow[];
  }

  // Resolve the components a meal needs that aren't already cached, OUTSIDE any
  // transaction (this is the async/network phase). Idempotent: a component already
  // present in `component_nutrients` is never re-resolved ("resolve once, replay
  // forever"). Returns the rows to cache in the subsequent atomic write.
  const resolveNewRows = async (components: ComponentSpec[]): Promise<ReferenceRow[]> => {
    const resolve = strategy.resolve;
    if (!resolve) return [];
    const read = backend.readHandle();
    // Dedup, then drop components already cached/seeded ("resolve once, replay
    // forever"). The remaining distinct components are independent, so resolve
    // them in PARALLEL — a 3-component meal pays 1× network RTT, not 3× serial.
    const uncached = [...new Set(components.map((c) => c.component))].filter(
      (component) =>
        read.query("component_nutrients", { eq: ["component", component] }).length === 0,
    );
    const resolved = await Promise.all(uncached.map((component) => resolve(component)));
    // null → component just won't contribute; flatten the rest into the cache set.
    return resolved.flatMap((rows) => rows ?? []);
  };

  // Two-phase logMeal: `prepare` resolves unknown components over the network
  // OUTSIDE the transaction; `commit` does the atomic DB writes synchronously
  // INSIDE it. With the OFFLINE strategy (no `resolve`) prepare stays SYNCHRONOUS
  // (returns a value, not a promise), so the offline path is fully synchronous and
  // keyless — identical to v0.
  const logMeal: PreparedHandler<Message> = {
    prepare(req): LoggedMeal | Promise<LoggedMeal> {
      const r = req as LogMealRequest;
      const { name, components } = parseMeal(r);
      const eatenAt = r.eatenAt !== 0n ? Number(r.eatenAt) : Date.now();
      if (!strategy.resolve) return { name, eatenAt, components, newRows: [] };
      return resolveNewRows(components).then((newRows) => ({
        name,
        eatenAt,
        components,
        newRows,
      }));
    },
    commit(prepared, _r, { data }) {
      const { name, eatenAt, components, newRows } = prepared as LoggedMeal;
      const mealId = randomUUID();
      data.insert("meals", { id: mealId, name, eaten_at: eatenAt });
      for (const c of components) {
        data.insert("meal_components", {
          id: randomUUID(),
          meal_id: mealId,
          component: c.component,
          qty_g: c.qty_g,
        });
      }
      // Cache the freshly-resolved reference rows in the same atomic write.
      // `onConflict: "ignore"` makes this idempotent: two concurrent log_meal
      // requests for the SAME novel component each resolve outside the txn and
      // both reach here, so without IGNORE the second commit would hit the
      // (component, nutrient) composite-PK UNIQUE constraint and roll the whole
      // meal back. INSERT OR IGNORE dedups the reference row instead.
      for (const row of newRows) {
        data.insert(
          "component_nutrients",
          {
            component: row.component,
            nutrient: row.nutrient,
            kind: row.kind,
            unit: row.unit,
            amount_per_100g: row.amount_per_100g,
          },
          { onConflict: "ignore" },
        );
      }
      return { meal_id: mealId };
    },
  };

  const handlers: Handlers = {
    logMeal,

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
  const app = defineApp({ name: "nutrition", version: "0.0.0", operations });
  return { app, close: () => backend.close() };
}
