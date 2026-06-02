/**
 * db.ts — Opens (or creates) the SQLite database and sets up the medallion schema.
 *
 * SAFETY NOTE: All SQL in this app uses parameterized prepared statements with
 * bound parameters. User-supplied strings are NEVER interpolated into SQL text.
 * This is the injection-safety property Chamber wants to enforce structurally at
 * the data-store interface level, so that MCP tools cannot accidentally (or
 * maliciously) concatenate user input into queries.
 */

import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "nutrition.db");

export function openDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function applySchema(db: Database.Database): void {
  db.exec(`
    -- ─── BRONZE layer: raw ingest (the ONLY layer written at runtime) ────────────
    CREATE TABLE IF NOT EXISTS meals (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      eaten_at  INTEGER NOT NULL  -- Unix timestamp ms
    );

    CREATE TABLE IF NOT EXISTS meal_components (
      id          TEXT PRIMARY KEY,
      meal_id     TEXT NOT NULL REFERENCES meals(id),
      component   TEXT NOT NULL,   -- free-text, e.g. "grilled chicken"
      qty_g       REAL NOT NULL
    );

    -- ─── SILVER layer: normalized facts ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ingredients (
      id             TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL UNIQUE
    );

    -- Maps free-text component strings → one or more ingredients + fraction
    CREATE TABLE IF NOT EXISTS component_ingredients (
      component     TEXT NOT NULL,
      ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
      fraction      REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (component, ingredient_id)
    );

    -- ─── GOLD layer: reference data + curated view ───────────────────────────────
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

    -- Gold view: per-meal × per-nutrient aggregated totals
    -- amount = SUM(qty_g / 100.0 * fraction * amount_per_100g)
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
}
