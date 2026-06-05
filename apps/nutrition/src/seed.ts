/**
 * seed.ts — Idempotent reference ("classification") data for the SILVER and GOLD layers.
 *
 * Phase 1 of the "loading the classification data" plan (docs/nutrition-meal-log-design.md §11):
 * the reference data lives in declarative, version-controlled files under ./data/ instead of
 * hardcoded arrays, loaded by a generic loader that:
 *   1. reads the bundled seed files (JSON for nested/small, CSV for the flat nutrition matrix),
 *   2. VALIDATES shape + referential integrity (fail loudly on a bad seed),
 *   3. inserts in FK-dependency order inside one transaction.
 *
 * SAFETY: every value is a bound parameter to a prepared statement — no string interpolation.
 * IDEMPOTENT: INSERT OR IGNORE means a re-run never duplicates or overwrites existing rows
 * (so runtime-acquired data is safe). Source/precedence-ranked upserts arrive with the richer
 * schema migration (see the design doc); they are intentionally out of scope here because the
 * current schema has no `source` columns and tests pin the table shapes.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

interface Ingredient { id: string; canonical_name: string; }
interface ComponentMapping { component: string; ingredient_id: string; fraction: number; }
interface Nutrient { id: string; name: string; kind: "macro" | "micro"; unit: string; }
interface IngredientNutrient { ingredient_id: string; nutrient_id: string; amount_per_100g: number; }

/** Read + parse a JSON seed file, failing loudly with the file name on a parse error. */
function readJson<T>(file: string): T {
  const full = path.join(DATA_DIR, file);
  let raw: string;
  try {
    raw = fs.readFileSync(full, "utf8");
  } catch (e: any) {
    throw new Error(`seed: cannot read ${file}: ${e?.message ?? e}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e: any) {
    throw new Error(`seed: ${file} is not valid JSON: ${e?.message ?? e}`);
  }
}

/** Minimal CSV reader for the flat nutrition matrix. Values are ids/numbers (no quoting/commas),
 *  so a header-driven split is sufficient; malformed rows fail loudly. */
function readCsv(file: string, columns: string[]): Record<string, string>[] {
  const full = path.join(DATA_DIR, file);
  const text = fs.readFileSync(full, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error(`seed: ${file} is empty`);
  const header = lines[0].split(",").map((h) => h.trim());
  for (const col of columns) {
    if (!header.includes(col)) throw new Error(`seed: ${file} missing column "${col}" (header: ${header.join(",")})`);
  }
  return lines.slice(1).map((line, i) => {
    const cells = line.split(",");
    if (cells.length !== header.length) {
      throw new Error(`seed: ${file} line ${i + 2} has ${cells.length} cells, expected ${header.length}`);
    }
    const row: Record<string, string> = {};
    header.forEach((h, j) => (row[h] = cells[j].trim()));
    return row;
  });
}

function nonEmpty(v: unknown): v is string { return typeof v === "string" && v.trim() !== ""; }

/** Validate shape + referential integrity before touching the DB. Throws on the first problem. */
function validate(
  nutrients: Nutrient[],
  ingredients: Ingredient[],
  mappings: ComponentMapping[],
  ingredientNutrients: IngredientNutrient[]
): void {
  const nutrientIds = new Set<string>();
  for (const n of nutrients) {
    if (!nonEmpty(n.id) || !nonEmpty(n.name) || !nonEmpty(n.unit)) throw new Error(`seed: bad nutrient row ${JSON.stringify(n)}`);
    if (n.kind !== "macro" && n.kind !== "micro") throw new Error(`seed: nutrient ${n.id} has invalid kind "${n.kind}"`);
    if (nutrientIds.has(n.id)) throw new Error(`seed: duplicate nutrient id "${n.id}"`);
    nutrientIds.add(n.id);
  }

  const ingredientIds = new Set<string>();
  for (const ing of ingredients) {
    if (!nonEmpty(ing.id) || !nonEmpty(ing.canonical_name)) throw new Error(`seed: bad ingredient row ${JSON.stringify(ing)}`);
    if (ingredientIds.has(ing.id)) throw new Error(`seed: duplicate ingredient id "${ing.id}"`);
    ingredientIds.add(ing.id);
  }

  for (const m of mappings) {
    if (!nonEmpty(m.component)) throw new Error(`seed: mapping with empty component ${JSON.stringify(m)}`);
    if (!ingredientIds.has(m.ingredient_id)) throw new Error(`seed: mapping "${m.component}" references unknown ingredient_id "${m.ingredient_id}"`);
    if (typeof m.fraction !== "number" || !(m.fraction > 0) || m.fraction > 1) throw new Error(`seed: mapping "${m.component}" has invalid fraction ${m.fraction} (expected 0 < f <= 1)`);
  }

  for (const inu of ingredientNutrients) {
    if (!ingredientIds.has(inu.ingredient_id)) throw new Error(`seed: ingredient_nutrients references unknown ingredient_id "${inu.ingredient_id}"`);
    if (!nutrientIds.has(inu.nutrient_id)) throw new Error(`seed: ingredient_nutrients references unknown nutrient_id "${inu.nutrient_id}"`);
    if (!Number.isFinite(inu.amount_per_100g) || inu.amount_per_100g < 0) throw new Error(`seed: ${inu.ingredient_id}/${inu.nutrient_id} has invalid amount_per_100g ${inu.amount_per_100g}`);
  }
}

export function seedReferenceData(db: Database.Database): void {
  // ── 1. load declarative seed files ────────────────────────────────────────
  const nutrients = readJson<Nutrient[]>("nutrients.json");
  const ingredients = readJson<Ingredient[]>("ingredients.json");
  const mappings = readJson<ComponentMapping[]>("component_mappings.json");
  const ingredientNutrients = readCsv("ingredient_nutrients.csv", ["ingredient_id", "nutrient_id", "amount_per_100g"]).map((r) => ({
    ingredient_id: r.ingredient_id,
    nutrient_id: r.nutrient_id,
    amount_per_100g: Number(r.amount_per_100g),
  }));

  // ── 2. validate shape + referential integrity (fail loudly) ───────────────
  validate(nutrients, ingredients, mappings, ingredientNutrients);

  // ── 3. insert in FK-dependency order, idempotently, in one transaction ────
  const insertNutrient = db.prepare(
    `INSERT OR IGNORE INTO nutrients (id, name, kind, unit) VALUES (@id, @name, @kind, @unit)`
  );
  const insertIngredient = db.prepare(
    `INSERT OR IGNORE INTO ingredients (id, canonical_name) VALUES (@id, @canonical_name)`
  );
  const insertMapping = db.prepare(
    `INSERT OR IGNORE INTO component_ingredients (component, ingredient_id, fraction)
     VALUES (@component, @ingredient_id, @fraction)`
  );
  const insertIngNut = db.prepare(
    `INSERT OR IGNORE INTO ingredient_nutrients (ingredient_id, nutrient_id, amount_per_100g)
     VALUES (@ingredient_id, @nutrient_id, @amount_per_100g)`
  );

  const seedAll = db.transaction(() => {
    for (const nut of nutrients)            insertNutrient.run(nut);
    for (const ing of ingredients)          insertIngredient.run(ing);
    for (const cm of mappings)              insertMapping.run(cm);
    for (const inu of ingredientNutrients)  insertIngNut.run(inu);
  });

  seedAll();
}
