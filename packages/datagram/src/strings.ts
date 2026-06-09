/**
 * strings.ts — the one home for the SDK's identifier/casing helpers.
 *
 * These were duplicated three ways (the runner's `snakeCase`/`humanize`, the
 * inline regex in `schema.tableName`, and a second `humanize` in the nutrition
 * CalorieNinjas strategy). Consolidating them here means a CamelCase edge case is
 * fixed once, in one place, for every caller. Exported from the package index so
 * apps can reuse the same rules instead of re-deriving them.
 */

/** The boundary regex that splits `lowerUPPER` so `camelCase` words can be separated. */
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;

/** snake_case a name: `LogMeal` → `log_meal`, `NutritionFor` → `nutrition_for`. */
export function snakeCase(name: string): string {
  return name.replace(CAMEL_BOUNDARY, "$1_$2").toLowerCase();
}

/** Title-case a list of lowercase words: `["fat","saturated"]` → "Fat Saturated". */
function titleCase(words: string[]): string {
  return words
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Humanize a CamelCase name into a sentence-cased summary: `NutritionFor` → "Nutrition for". */
export function humanize(name: string): string {
  const lowered = name.replace(CAMEL_BOUNDARY, "$1 $2").toLowerCase();
  return lowered.charAt(0).toUpperCase() + lowered.slice(1);
}

/** Title-case a snake_case field, dropping a trailing unit suffix: `fat_saturated_g` → "Fat Saturated". */
export function humanizeField(field: string): string {
  return titleCase(field.replace(/_(g|mg|mcg)$/, "").split("_"));
}

/** Naive English pluralization, sufficient for the v0 dataset names. */
export function pluralize(s: string): string {
  if (s.endsWith("s")) return s;
  if (s.endsWith("y")) return `${s.slice(0, -1)}ies`;
  return `${s}s`;
}
