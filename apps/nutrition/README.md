# Chamber Nutrition Tracker — Prototype

A small CLI nutrition tracker that demonstrates a **medallion (Bronze / Silver / Gold)** SQLite data architecture. Built as a throwaway prototype to inform Chamber's shared data-store interface design.

## Run the demo

```bash
cd apps/nutrition
npm install
npm run demo
```

## CLI commands

```bash
# Log a meal (writes Bronze layer)
npx tsx src/cli.ts log \
  --name "Chicken burrito bowl" \
  --component "grilled chicken:150" \
  --component "brown rice:200" \
  --component "olive oil:10"

# Show Gold-view nutrition for a meal
npx tsx src/cli.ts nutrition --meal <id>

# List all logged meals
npx tsx src/cli.ts meals
```

## Architecture

| Layer  | Tables | Purpose |
|--------|--------|---------|
| Bronze | `meals`, `meal_components` | Raw ingest — only layer written at runtime |
| Silver | `ingredients`, `component_ingredients` | Normalized entity mappings |
| Gold   | `nutrients`, `ingredient_nutrients`, `gold_meal_nutrition` (VIEW) | Reference data + curated aggregation view |

## Safety

All SQL uses **parameterized prepared statements**. User input is never interpolated into SQL text. This is the injection-safety property Chamber aims to enforce structurally at the data-store interface.

## SQLite library

`better-sqlite3` (native Node addon). Falls back to `sql.js` (WASM) if the native build fails.
