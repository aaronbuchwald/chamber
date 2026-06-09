# Design: Delete meals (per-meal + full-day)

## Goal
Add the ability to delete a logged meal, and to delete all meals for a given day.
Exposed through every entrypoint (CLI, HTTP, MCP) and surfaced in the SPA with a
per-meal delete icon and a top-bar "clear day" delete icon.

## Data model constraints (from db.ts / operations.ts)
- `meal_components.meal_id REFERENCES meals(id)` with **no `ON DELETE CASCADE`**, and
  `PRAGMA foreign_keys = ON`. → A meal cannot be deleted while its component rows
  exist; we must delete `meal_components` first, then the `meals` row, inside a
  single transaction.
- Silver (`ingredients`, `component_ingredients`) and Gold (`ingredient_nutrients`,
  reference data) are **shared cache/reference across meals** — never deleted here.
- `gold_meal_nutrition` is a VIEW; it recomputes automatically once the bronze rows
  are gone. No view maintenance needed.
- Injection-safety invariant: all SQL uses bound parameters, never string concat.

## Core operations (operations.ts)
```ts
// Delete one meal + its components. Returns rows deleted (0 if not found, 1 if deleted).
export function deleteMeal(db, mealId: string): { deleted: number }

// Delete every meal whose eaten_at ∈ [from, to) plus their components.
// Returns count of meals deleted.
export function deleteMealsInRange(db, from: number, to: number): { deleted: number }
```
Both run in a transaction: delete child `meal_components` rows (by `meal_id`, or by
`meal_id IN (SELECT id FROM meals WHERE eaten_at >= @from AND eaten_at < @to)`), then
the `meals` rows. Half-open range `[from, to)` so day boundaries never double-count.

## App operations (app.ts) — auto-exposed to CLI/HTTP/MCP via appkit
- `delete_meal` — `{ meal_id: string }` → `{ deleted: number }`, `mutates: true`
- `delete_day` — `{ date: string }` (`YYYY-MM-DD`) → `{ deleted: number }`, `mutates: true`

`mutates: true` ⇒ both fire the SSE mutation event, so all open views (incl. the
Obsidian iframe) refresh live after a delete.

### Day-bounds contract (DECIDED)
`delete_day` takes `{ date: "YYYY-MM-DD" }`. The **app-layer handler** resolves it to a
half-open day window in **server-local time** and calls the timezone-agnostic core:
```ts
const [y, m, d] = date.split("-").map(Number);            // validate via zod regex first
const from = new Date(y, m - 1, d).getTime();             // local midnight
const to   = new Date(y, m - 1, d + 1).getTime();         // next local midnight
return deleteMealsInRange(db, from, to);
```
The timezone assumption is localized to the app handler; the core op stays a pure
`[from, to)` range delete (keeps it trivially testable). The SPA passes the `selectedDate`
string it already tracks; CLI is `delete_day --date 2026-06-08`; MCP gets a clean
`{ date }` arg. Validate `date` with a `^\d{4}-\d{2}-\d{2}$` zod regex.

## UI (public/index.html)
- **Per-meal delete:** a small trash icon on the right of each `.meal-head` row (before
  the chevron). `click` calls `stopPropagation()` so it doesn't toggle the card open,
  shows a `confirm("Delete \"<name>\"?")`, then `call("delete_meal", { meal_id })`.
- **Full-day delete:** a trash icon button in the toolbar, labeled **"Clear day"**
  (title/aria-label `Delete all meals for <day>`). Disabled when the day has 0 meals.
  `confirm("Delete all N meals for <day>? This cannot be undone.")`, then
  `call("delete_day", { date: selectedDate })`.
- After either call, no manual refresh needed — the SSE push triggers `loadMeals()`.
  (We still `await loadMeals()` directly as a fallback for when SSE is unavailable.)
- Icons: small inline SVG trash glyph, styled with the existing button/`--muted`
  tokens; delete hover state uses `--danger`.

## Tests
- **unit** (operations): `deleteMeal` removes the meal + its components and drops it
  from the gold view; deleting a missing id returns `{ deleted: 0 }`; deleting one meal
  leaves others and leaves shared silver/gold reference intact (a later meal reusing the
  same component still resolves nutrition). `deleteMealsInRange` deletes only meals in
  `[from, to)` and returns the right count.
- **integration** (HTTP): `POST /delete_meal` and `POST /delete_day` return
  `{ result: { deleted } }`; deleting then `list_meals` reflects the removal.
- **SSE**: a `delete_meal` write pushes a mutation event (extend existing sse.test.ts).
- **adversarial**: unknown meal_id → `deleted: 0`, no throw; malformed `date`
  (e.g. `2026-13-40`, `"today"`) rejected by the zod regex → HTTP 400.

## Rollout note
This **adds operations**, i.e. changes each app's OpenAPI schema. The gateway snapshots
OpenAPI at startup, so picking up the new MCP tools needs a **full `./start.sh`**
(not `--app`), so the gateway re-reads the specs.

## Out of scope
- Undo / soft-delete (hard delete only).
- Bulk multi-select delete in the UI (only single + whole-day).
- Pruning now-orphaned silver/gold cache rows (intentionally retained as reference).
```
