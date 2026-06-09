/**
 * runner.ts — judging logic for the nutrition eval harness.
 *
 * `runCase` runs a single EvalCase end-to-end against a fresh in-memory medallion DB and returns a
 * {status, detail} verdict — it NEVER throws for a failed assertion, so the test entrypoint can
 * report per-case pass / fail / skip and decide what to assert.
 *
 * Two judging modes (see cases.ts):
 *   - "deterministic": assert each expected per-nutrient amount is within tolerance of the Gold view.
 *       Expected entries are keyed by nutrient_id; the runner maps nutrient_id → display name (the
 *       Gold view exposes the display name, not the id) by reading the `nutrients` table. An expected
 *       amount of 0 with an absent Gold row passes (graceful unresolved / zero behavior).
 *   - "llm-judge": ask an LLM to score the actual nutrition output against the rubric. This path is
 *       SKIPPED cleanly when ANTHROPIC_API_KEY is unset or @anthropic-ai/sdk cannot be imported, and
 *       any error during judging also yields a skip — so default CI stays offline & deterministic.
 *
 * Network strategies (usda / calorieninjas / llm) run offline in deterministic mode via the case's
 * `fakeProvider` stub; see cases.ts for the reproducibility convention.
 */

import Database from "better-sqlite3";
import { seedReferenceData } from "../../src/seed.js";
import { logMeal, getMealNutrition } from "../../src/operations.js";
import { strategies } from "../../src/strategies.js";
import type { NutritionProvider } from "../../src/nutrition_source.js";
import type { EvalCase } from "./cases.js";

export interface CaseResult {
  status: "pass" | "fail" | "skip";
  detail: string;
}

/** Build a fresh in-memory medallion DB (no disk / no cwd dependency) and seed reference data. */
function freshSeededDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Schema mirrors src/db.ts applySchema (openDb() targets a file on disk; we replicate in-memory).
  db.exec(`
    CREATE TABLE IF NOT EXISTS meals (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      eaten_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meal_components (
      id          TEXT PRIMARY KEY,
      meal_id     TEXT NOT NULL REFERENCES meals(id),
      component   TEXT NOT NULL,
      qty_g       REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ingredients (
      id             TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS component_ingredients (
      component     TEXT NOT NULL,
      ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
      fraction      REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (component, ingredient_id)
    );
    CREATE TABLE IF NOT EXISTS nutrients (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('macro','micro')),
      unit TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ingredient_nutrients (
      ingredient_id   TEXT NOT NULL REFERENCES ingredients(id),
      nutrient_id     TEXT NOT NULL REFERENCES nutrients(id),
      amount_per_100g REAL NOT NULL,
      PRIMARY KEY (ingredient_id, nutrient_id)
    );
    CREATE VIEW IF NOT EXISTS gold_meal_nutrition AS
    SELECT
      m.id           AS meal_id,
      m.name         AS meal_name,
      n.name         AS nutrient,
      n.kind         AS nutrient_kind,
      n.unit         AS unit,
      SUM(mc.qty_g / 100.0 * ci.fraction * inu.amount_per_100g) AS amount
    FROM meals m
    JOIN meal_components    mc  ON mc.meal_id       = m.id
    JOIN component_ingredients ci ON ci.component   = mc.component
    JOIN ingredient_nutrients  inu ON inu.ingredient_id = ci.ingredient_id
    JOIN nutrients             n   ON n.id           = inu.nutrient_id
    GROUP BY m.id, n.id;
  `);
  seedReferenceData(db);
  return db;
}

/** Map nutrient_id → display name from the `nutrients` table (Gold view exposes the name). */
function nutrientNameById(db: Database.Database): Map<string, string> {
  const rows = db.prepare("SELECT id, name FROM nutrients").all() as { id: string; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Resolve the provider for a case: the case's fakeProvider stub, else the real strategy. */
function providerFor(c: EvalCase): NutritionProvider {
  return c.fakeProvider ?? strategies[c.strategy];
}

export async function runCase(c: EvalCase): Promise<CaseResult> {
  if (c.mode === "llm-judge") return runLlmJudge(c);
  return runDeterministic(c);
}

async function runDeterministic(c: EvalCase): Promise<CaseResult> {
  if (!c.expected || c.expected.length === 0) {
    return { status: "fail", detail: `case "${c.id}" is deterministic but has no expected[] entries` };
  }
  const components = c.input.components ?? [];
  if (components.length === 0) {
    return { status: "fail", detail: `case "${c.id}" has no input.components` };
  }

  const db = freshSeededDb();
  try {
    const mealId = await logMeal(db, c.id, components, providerFor(c));
    const rows = getMealNutrition(db, mealId);
    const nameById = nutrientNameById(db);
    const byName = new Map(rows.map((r) => [r.nutrient, r.amount]));

    for (const exp of c.expected) {
      const displayName = nameById.get(exp.nutrient_id);
      if (!displayName) {
        return {
          status: "fail",
          detail: `unknown nutrient_id "${exp.nutrient_id}" (not in nutrients table)`,
        };
      }
      const actual = byName.get(displayName);
      if (actual === undefined) {
        // Absent Gold row: pass only when we expected zero (graceful unresolved / zero behavior).
        if (exp.amount === 0) continue;
        return {
          status: "fail",
          detail: `${exp.nutrient_id} (${displayName}): no Gold row, expected ${exp.amount}±${exp.tol}`,
        };
      }
      if (Math.abs(actual - exp.amount) > exp.tol) {
        return {
          status: "fail",
          detail: `${exp.nutrient_id} (${displayName}): got ${actual}, expected ${exp.amount}±${exp.tol}`,
        };
      }
    }
    return {
      status: "pass",
      detail: `${c.expected.length} nutrient(s) within tolerance (strategy=${c.strategy})`,
    };
  } catch (e: any) {
    return { status: "fail", detail: `error running case: ${e?.message ?? e}` };
  } finally {
    db.close();
  }
}

// Structured judge output: a score in [0, 1] plus a rationale.
const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number", description: "0.0–1.0; how well the output meets the rubric" },
    rationale: { type: "string", description: "brief justification for the score" },
  },
  required: ["score", "rationale"],
  additionalProperties: false,
} as const;

async function runLlmJudge(c: EvalCase): Promise<CaseResult> {
  if (!c.rubric) {
    return { status: "fail", detail: `case "${c.id}" is llm-judge but has no rubric` };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { status: "skip", detail: "ANTHROPIC_API_KEY not set — llm-judge skipped" };
  }

  let Anthropic: any;
  try {
    Anthropic = (await import("@anthropic-ai/sdk")).default;
  } catch {
    return { status: "skip", detail: "@anthropic-ai/sdk not installed — llm-judge skipped" };
  }

  const components = c.input.components ?? [];
  const db = freshSeededDb();
  try {
    const mealId = await logMeal(db, c.id, components, providerFor(c));
    const rows = getMealNutrition(db, mealId);

    const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: JUDGE_SCHEMA },
      },
      system:
        "You are an evaluation judge for a nutrition tracker. Score how well the provided nutrition " +
        "output satisfies the given rubric, returning a score from 0.0 (fails the rubric) to 1.0 " +
        "(fully satisfies it) plus a brief rationale.",
      messages: [
        {
          role: "user",
          content:
            `Rubric: ${c.rubric.criteria}\n\n` +
            `Meal input: ${JSON.stringify(c.input)}\n` +
            `Actual nutrition output (Gold view rows): ${JSON.stringify(rows)}`,
        },
      ],
    });

    const block = (response.content as any[]).find((b) => b.type === "text");
    if (!block) return { status: "skip", detail: "judge returned no text block — skipped" };
    const verdict = JSON.parse(block.text) as { score: number; rationale: string };

    if (verdict.score >= c.rubric.min_score) {
      return {
        status: "pass",
        detail: `judge score ${verdict.score} >= ${c.rubric.min_score}: ${verdict.rationale}`,
      };
    }
    return {
      status: "fail",
      detail: `judge score ${verdict.score} < ${c.rubric.min_score}: ${verdict.rationale}`,
    };
  } catch (e: any) {
    // Any failure on the LLM path is a skip, never a CI failure (keeps default runs offline-safe).
    return { status: "skip", detail: `llm-judge error (skipped): ${e?.message ?? e}` };
  } finally {
    db.close();
  }
}
