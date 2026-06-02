/**
 * seed.ts — Idempotent reference data for SILVER and GOLD layers.
 *
 * Uses INSERT OR IGNORE so it is safe to call on every startup.
 * All values are bound parameters — no string interpolation into SQL.
 */

import Database from "better-sqlite3";

interface Ingredient {
  id: string;
  canonical_name: string;
}

interface ComponentMapping {
  component: string;
  ingredient_id: string;
  fraction: number;
}

interface Nutrient {
  id: string;
  name: string;
  kind: "macro" | "micro";
  unit: string;
}

interface IngredientNutrient {
  ingredient_id: string;
  nutrient_id: string;
  amount_per_100g: number;
}

export function seedReferenceData(db: Database.Database): void {
  // ── SILVER: ingredients ───────────────────────────────────────────────────
  const ingredients: Ingredient[] = [
    { id: "ing_chicken",  canonical_name: "grilled chicken" },
    { id: "ing_rice",     canonical_name: "brown rice" },
    { id: "ing_olive",    canonical_name: "olive oil" },
    { id: "ing_broccoli", canonical_name: "broccoli" },
    { id: "ing_egg",      canonical_name: "egg" },
    { id: "ing_oats",     canonical_name: "rolled oats" },
  ];

  // ── SILVER: free-text component → ingredient mappings ────────────────────
  // Covers the typical free-text strings a user would type.
  // A component can map to multiple ingredients (e.g. a mixed dish); fraction
  // represents the ingredient's weight share of that component.
  const componentMappings: ComponentMapping[] = [
    { component: "grilled chicken", ingredient_id: "ing_chicken",  fraction: 1.0 },
    { component: "brown rice",      ingredient_id: "ing_rice",     fraction: 1.0 },
    { component: "olive oil",       ingredient_id: "ing_olive",    fraction: 1.0 },
    { component: "broccoli",        ingredient_id: "ing_broccoli", fraction: 1.0 },
    { component: "egg",             ingredient_id: "ing_egg",      fraction: 1.0 },
    { component: "scrambled eggs",  ingredient_id: "ing_egg",      fraction: 1.0 },
    { component: "oatmeal",         ingredient_id: "ing_oats",     fraction: 1.0 },
    { component: "rolled oats",     ingredient_id: "ing_oats",     fraction: 1.0 },
  ];

  // ── GOLD: nutrients ───────────────────────────────────────────────────────
  const nutrients: Nutrient[] = [
    { id: "nut_protein",  name: "Protein",    kind: "macro",  unit: "g" },
    { id: "nut_carbs",    name: "Carbs",      kind: "macro",  unit: "g" },
    { id: "nut_fat",      name: "Fat",        kind: "macro",  unit: "g" },
    { id: "nut_vitc",     name: "Vitamin C",  kind: "micro",  unit: "mg" },
    { id: "nut_iron",     name: "Iron",       kind: "micro",  unit: "mg" },
  ];

  // ── GOLD: ingredient_nutrients (per 100 g, approximate real values) ──────
  const ingredientNutrients: IngredientNutrient[] = [
    // Grilled chicken (~31g protein, 0g carbs, 3.6g fat, 0mg vit-C, 1.0mg iron per 100g)
    { ingredient_id: "ing_chicken",  nutrient_id: "nut_protein", amount_per_100g: 31.0 },
    { ingredient_id: "ing_chicken",  nutrient_id: "nut_carbs",   amount_per_100g:  0.0 },
    { ingredient_id: "ing_chicken",  nutrient_id: "nut_fat",     amount_per_100g:  3.6 },
    { ingredient_id: "ing_chicken",  nutrient_id: "nut_vitc",    amount_per_100g:  0.0 },
    { ingredient_id: "ing_chicken",  nutrient_id: "nut_iron",    amount_per_100g:  1.0 },
    // Brown rice (cooked: 2.6g protein, 23g carbs, 0.9g fat, 0mg vit-C, 0.5mg iron)
    { ingredient_id: "ing_rice",     nutrient_id: "nut_protein", amount_per_100g:  2.6 },
    { ingredient_id: "ing_rice",     nutrient_id: "nut_carbs",   amount_per_100g: 23.0 },
    { ingredient_id: "ing_rice",     nutrient_id: "nut_fat",     amount_per_100g:  0.9 },
    { ingredient_id: "ing_rice",     nutrient_id: "nut_vitc",    amount_per_100g:  0.0 },
    { ingredient_id: "ing_rice",     nutrient_id: "nut_iron",    amount_per_100g:  0.5 },
    // Olive oil (0g protein, 0g carbs, 100g fat, 0mg vit-C, 0.6mg iron)
    { ingredient_id: "ing_olive",    nutrient_id: "nut_protein", amount_per_100g:  0.0 },
    { ingredient_id: "ing_olive",    nutrient_id: "nut_carbs",   amount_per_100g:  0.0 },
    { ingredient_id: "ing_olive",    nutrient_id: "nut_fat",     amount_per_100g: 100.0 },
    { ingredient_id: "ing_olive",    nutrient_id: "nut_vitc",    amount_per_100g:  0.0 },
    { ingredient_id: "ing_olive",    nutrient_id: "nut_iron",    amount_per_100g:  0.6 },
    // Broccoli (2.8g protein, 6.6g carbs, 0.4g fat, 89.2mg vit-C, 0.7mg iron)
    { ingredient_id: "ing_broccoli", nutrient_id: "nut_protein", amount_per_100g:  2.8 },
    { ingredient_id: "ing_broccoli", nutrient_id: "nut_carbs",   amount_per_100g:  6.6 },
    { ingredient_id: "ing_broccoli", nutrient_id: "nut_fat",     amount_per_100g:  0.4 },
    { ingredient_id: "ing_broccoli", nutrient_id: "nut_vitc",    amount_per_100g: 89.2 },
    { ingredient_id: "ing_broccoli", nutrient_id: "nut_iron",    amount_per_100g:  0.7 },
    // Egg (13g protein, 1.1g carbs, 11g fat, 0mg vit-C, 1.8mg iron)
    { ingredient_id: "ing_egg",      nutrient_id: "nut_protein", amount_per_100g: 13.0 },
    { ingredient_id: "ing_egg",      nutrient_id: "nut_carbs",   amount_per_100g:  1.1 },
    { ingredient_id: "ing_egg",      nutrient_id: "nut_fat",     amount_per_100g: 11.0 },
    { ingredient_id: "ing_egg",      nutrient_id: "nut_vitc",    amount_per_100g:  0.0 },
    { ingredient_id: "ing_egg",      nutrient_id: "nut_iron",    amount_per_100g:  1.8 },
    // Rolled oats (17g protein, 66g carbs, 7g fat, 0mg vit-C, 4.7mg iron)
    { ingredient_id: "ing_oats",     nutrient_id: "nut_protein", amount_per_100g: 17.0 },
    { ingredient_id: "ing_oats",     nutrient_id: "nut_carbs",   amount_per_100g: 66.0 },
    { ingredient_id: "ing_oats",     nutrient_id: "nut_fat",     amount_per_100g:  7.0 },
    { ingredient_id: "ing_oats",     nutrient_id: "nut_vitc",    amount_per_100g:  0.0 },
    { ingredient_id: "ing_oats",     nutrient_id: "nut_iron",    amount_per_100g:  4.7 },
  ];

  // All inserts use bound parameters — no user input here but the pattern is
  // identical to runtime inserts, demonstrating the same safety property.
  const insertIngredient = db.prepare(
    `INSERT OR IGNORE INTO ingredients (id, canonical_name) VALUES (@id, @canonical_name)`
  );
  const insertMapping = db.prepare(
    `INSERT OR IGNORE INTO component_ingredients (component, ingredient_id, fraction)
     VALUES (@component, @ingredient_id, @fraction)`
  );
  const insertNutrient = db.prepare(
    `INSERT OR IGNORE INTO nutrients (id, name, kind, unit)
     VALUES (@id, @name, @kind, @unit)`
  );
  const insertIngNut = db.prepare(
    `INSERT OR IGNORE INTO ingredient_nutrients (ingredient_id, nutrient_id, amount_per_100g)
     VALUES (@ingredient_id, @nutrient_id, @amount_per_100g)`
  );

  // Run all seed inserts in a single transaction for speed + atomicity
  const seedAll = db.transaction(() => {
    for (const ing of ingredients)        insertIngredient.run(ing);
    for (const cm  of componentMappings)  insertMapping.run(cm);
    for (const nut of nutrients)          insertNutrient.run(nut);
    for (const inu of ingredientNutrients) insertIngNut.run(inu);
  });

  seedAll();
}
