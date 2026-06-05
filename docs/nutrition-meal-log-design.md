# Nutrition Meal-Log — Data Design

Status: draft / design exploration
Scope: the `apps/nutrition` data model and resolution pipeline. Consolidates the
design discussion around low-friction logging, the medallion architecture, offline
behavior, deterministic resolution, normalization, and reference-data recompute.

---

## 1. Goals & principles

- **Logging must be frictionless.** The user types/says `"chicken bowl"` and it is
  saved immediately — no components, no grams required.
- **Components + nutrition are *enrichment*, not preconditions.** They are derived
  later, possibly with a network call, then cached forever and always correctable.
- **Offline-first.** Capture never touches the network. Enrichment degrades
  gracefully and is retried when connectivity returns.
- **Deterministic & uniform.** The same phrase logged on different days must resolve
  to the *same* silver/gold mapping. The fuzzy/online step runs **once per novel
  phrase**; everything after is replay.
- **Trustworthy.** Every derived fact carries `source` + `confidence`; user
  corrections become high-confidence facts that seed future resolutions.

The guiding inversion: today's schema makes `(component, qty_g)` a *precondition*
for logging. We flip that — **capture is instant and lossless; enrichment is lazy.**
This maps onto medallion almost exactly:

```
 CAPTURE (always offline, never blocks)        ENRICHMENT (lazy, may need network, cached)
 ┌─────────────┐    ┌───────────────────────────────────────────────────────────┐
 │  meal_log   │ ─▶ │ resolve phrase→template→ingredients→portions→nutrition      │
 │ (raw_text)  │    │   local cache hit → instant & offline                       │
 └─────────────┘    │   miss            → queue, fetch online, cache, done         │
   BRONZE           └───────────────────────────────────────────────────────────┘
                         SILVER (normalized)            GOLD (materialized totals)
```

---

## 2. Schema

### BRONZE — append-only capture (offline-always)

```sql
CREATE TABLE meal_log (
  id            TEXT PRIMARY KEY,
  eaten_at      INTEGER NOT NULL,        -- when eaten (defaults to now)
  logged_at     INTEGER NOT NULL,        -- when captured
  raw_text      TEXT NOT NULL,           -- EXACTLY what the user said
  portion_hint  TEXT,                    -- 'small'|'regular'|'large' | NULL (coarse, optional)
  input_method  TEXT NOT NULL,           -- 'text'|'voice'|'photo'|'quick_pick'|'manual'
  status        TEXT NOT NULL DEFAULT 'pending'
                 CHECK(status IN ('pending','resolving','resolved','needs_review','failed','manual')),
  resolved_meal_id TEXT                   -- → silver meal.id once enriched
);
```

`log_meal_quick(raw_text, portion_hint?, eaten_at?)` writes one row, synchronously,
no network, and returns. `status='pending'` is the signal to the enrichment worker.

### SILVER — normalized, deterministic, rebuildable

```sql
CREATE TABLE ingredients (
  id                TEXT PRIMARY KEY,
  canonical_name    TEXT NOT NULL UNIQUE,
  default_serving_g REAL,                 -- portion estimation without grams
  source            TEXT NOT NULL,        -- 'seed'|'external'|'llm'|'user'
  external_id       TEXT                  -- USDA fdcId / OFF barcode — cache key
);

CREATE TABLE ingredient_aliases (         -- free-text → canonical (replaces component_ingredients)
  alias         TEXT PRIMARY KEY,         -- normalized "grilled chicken breast"
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id)
);

CREATE TABLE meal_templates (             -- a named dish = a recipe of components
  id   TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT
);
CREATE TABLE template_components (
  template_id   TEXT NOT NULL REFERENCES meal_templates(id),
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
  qty_g         REAL NOT NULL,            -- grams for a 'regular' portion
  PRIMARY KEY (template_id, ingredient_id)
);

CREATE TABLE meal (                       -- resolved working set for one logged meal
  id TEXT PRIMARY KEY, log_id TEXT NOT NULL REFERENCES meal_log(id),
  name TEXT NOT NULL, eaten_at INTEGER NOT NULL
);
CREATE TABLE meal_component (
  id            TEXT PRIMARY KEY,
  meal_id       TEXT NOT NULL REFERENCES meal(id),
  ingredient_id TEXT REFERENCES ingredients(id),  -- NULL until matched
  raw_component TEXT NOT NULL,
  qty_g         REAL NOT NULL,
  source        TEXT NOT NULL,            -- 'template'|'llm'|'external'|'user'
  confidence    REAL NOT NULL DEFAULT 1.0
);

-- caches phrase → resolution so the SAME meal logs instantly & offline next time
CREATE TABLE phrase_resolution (
  phrase_norm        TEXT PRIMARY KEY,    -- canonicalized "chicken bowl"
  template_id        TEXT,
  source             TEXT NOT NULL,       -- 'local'|'fuzzy'|'embedding'|'llm'|'user'
  confidence         REAL NOT NULL,
  normalizer_version INTEGER NOT NULL,    -- which normalization algorithm produced phrase_norm
  resolved_at        INTEGER NOT NULL,
  raw_response       TEXT                 -- provenance / debugging
);
```

### GOLD — reference cache + materialized totals

```sql
CREATE TABLE nutrients (id TEXT PRIMARY KEY, name TEXT, kind TEXT, unit TEXT);

CREATE TABLE ingredient_nutrients (       -- lazily fetched, cached forever
  ingredient_id   TEXT NOT NULL REFERENCES ingredients(id),
  nutrient_id     TEXT NOT NULL REFERENCES nutrients(id),
  amount_per_100g REAL NOT NULL,
  source          TEXT NOT NULL,
  fetched_at      INTEGER NOT NULL,
  PRIMARY KEY (ingredient_id, nutrient_id)
);

CREATE TABLE meal_nutrition_mat (         -- MATERIALIZED per-meal totals (point-in-time snapshot)
  meal_id      TEXT NOT NULL,
  nutrient_id  TEXT NOT NULL,
  amount       REAL NOT NULL,
  ref_revision INTEGER NOT NULL,          -- reference revision this was computed under
  computed_at  INTEGER NOT NULL,
  PRIMARY KEY (meal_id, nutrient_id)
);

CREATE TABLE daily_nutrition_mat (        -- MATERIALIZED daily rollup (the dashboard read)
  day TEXT NOT NULL, nutrient_id TEXT NOT NULL,
  amount REAL NOT NULL, meal_count INTEGER NOT NULL,
  PRIMARY KEY (day, nutrient_id)
);
```

---

## 3. Resolution pipeline & offline behavior

`meal_log.status` is a small state machine driven by an enrichment worker in the
same app process:

```
pending ─▶ resolving ─▶ resolved
                   ├─▶ needs_review  (low confidence) ──user confirms──▶ resolved
                   └─▶ failed        (offline + cache miss) ──online again──▶ pending
```

Worker steps, each degrading gracefully offline:

1. **Normalize** `raw_text` → `phrase_norm` (see §5).
2. **Phrase → template:** `phrase_resolution` hit → instant/offline. Miss → fuzzy
   match local templates → still miss → queue for online resolution (lazy network).
3. **Template → ingredients:** via `ingredient_aliases`; unknown ingredient → online
   lookup, then cached as a new `ingredients` row.
4. **Portions without grams:** `qty_g = default_serving_g × portion_factor(portion_hint)`.
5. **Nutrition:** for any ingredient missing from `ingredient_nutrients`, fetch online,
   cache by `external_id`. (The one genuinely online-only step; amortizes to zero.)
6. **Materialize** `meal_nutrition_mat` + trigger bumps `daily_nutrition_mat`.
7. **Cache the resolution** into `phrase_resolution` → instant & fully offline next time.

**Offline guarantee:** capture never hits the network. A meal logged offline with an
unknown phrase sits `pending`/`failed`; the UI shows "nutrition pending"; the worker
drains the queue when connectivity returns. Ship a **seed cache of the ~100 most
common foods/dishes** so first-run is useful offline.

**Recommended engines:** an **LLM** for phrase→components decomposition; **USDA
FoodData Central** for per-100g nutrients (keyed by `fdcId`); **Open Food Facts** for
barcode/packaged items. Everything cached on first sight.

---

## 4. Determinism — "resolve once, replay forever"

The LLM/external source is consulted **only on a cache miss**. Once `"chicken bowl"`
resolves, that mapping is frozen into reference data; every future log is a pure DB
lookup. The contract:

1. **Deterministic normalizer** → unique pinned phrase→template mapping (§5).
2. **Immutable, versioned reference data** — `template_components.qty_g` and
   `ingredient_nutrients.amount_per_100g` don't change underneath you, so the
   conversion `qty_g/100 × amount_per_100g` is a pure function of versioned inputs.
3. **Per-meal point-in-time snapshot** — `meal_nutrition_mat` stores the computed
   `amount` + `ref_revision`, so improving a template later does not silently rewrite
   already-logged meals.

**First-write race** (two new identical phrases at once) is closed with single-flight
+ atomic pin:

```sql
INSERT INTO phrase_resolution(phrase_norm, template_id, ...)
VALUES (@phrase_norm, @template_id, ...)
ON CONFLICT(phrase_norm) DO NOTHING;     -- loser reads the winner's pin
```

plus a per-`phrase_norm` claim (`status='resolving'`) so only one worker resolves a
given novel phrase.

---

## 5. Normalization & canonicalization

> *"How do two slightly different descriptions get mapped to the same name?"*

This is entity resolution. Run a layered pipeline, cheapest → most powerful; the
**first layer that clears a confidence threshold wins and the result is pinned** into
`phrase_resolution` / `ingredient_aliases`, so expensive layers run at most once per
novel phrase and the system improves monotonically.

**Layer 0 — Lexical normalization (deterministic, offline, cheap).** Produces
`phrase_norm`. This is the cache key, so it must be stable and versioned
(`normalizer_version`):
- lowercase, trim, collapse whitespace, strip punctuation;
- strip stopwords/filler (`a`, `the`, `with`, `some`, `of`);
- pull out size/qualifier words (`large`, `small`, `extra`) into `portion_hint`
  instead of leaving them in the phrase;
- singularize/stem (`eggs`→`egg`); apply a synonym map (`&`→`and`, `veggie`→`vegetable`);
- **token-set canonicalization**: sort tokens so `"rice chicken bowl"` ==
  `"chicken rice bowl"`.

Catches casing, ordering, punctuation, plurals, filler — a large share of real
variation — with zero network and full determinism.

**Layer 1 — Exact alias hit.** Every confirmed resolution writes its `phrase_norm` →
`template_id`. Over time the alias set grows and exact match covers more. This is the
learning loop: a user correction *teaches* the canonical mapping permanently.

**Layer 2 — Fuzzy lexical match (offline).** On miss, before going online, compare
the `phrase_norm` against existing template names / aliases via token-set Jaccard or
edit distance (SQLite `spellfix1`/FTS5 can back this). Above threshold → reuse that
template; borderline → `needs_review`. Catches typos and near-duplicates.

**Layer 3 — Semantic embedding match.** Embed the phrase, nearest-neighbor against
template embeddings (cosine; `sqlite-vec` for storage). This is what actually unifies
*semantically* equivalent but lexically different phrases (`"chicken bowl"` ≈
`"grilled chicken rice bowl"`). Embeddings cached by `phrase_norm`. A local embedding
model keeps this offline; otherwise it's an online step that still runs once.

**Layer 4 — LLM canonicalization (online, last resort).** Ask: "does this describe the
same dish as any of these existing templates? {candidate list}" → returns an existing
`template_id` or "new". Most powerful, nondeterministic, online — so it runs once and
the answer is pinned.

**Precision vs. recall:** aggressive merging risks collapsing distinct foods
(`"chicken bowl"` vs `"chicken soup"`). Govern with confidence thresholds:
high-confidence → auto-map; mid → `needs_review` (one-tap user confirm); low → new
template. The human-in-the-loop confirmation is what makes the ambiguous middle
correct, and every confirmation feeds Layer 1.

---

## 6. Changing reference data & automatic recompute

> *"If I change the reference information, how do I automatically re-compute things?"*

Gold is a **pure function of bronze + silver + reference data** (the live
`gold_meal_nutrition` view is the definition). So recompute correctness is always
achievable; the design question is doing it *incrementally* and choosing *which*
changes flow back to history.

**Version everything.** A monotonic `ref_revision` is bumped on any reference change;
`meal_nutrition_mat.ref_revision` records what each row was computed under, so staleness
is detectable.

**Two classes of change — different policy:**

| Change | Effect | Default policy |
|---|---|---|
| **Nutrition value** (`ingredient_nutrients`) | components unchanged, only the conversion changes | **Safe to auto-recompute** — deterministic, same components × new per-100g |
| **Template / resolution** (different components or grams) | changes *what the meal is* | **Opt-in** — preserve history by default (point-in-time); offer "apply to past meals" as an explicit action |

**Dependency tracking — what to invalidate.** Find affected meals directly:

```sql
-- meals impacted by a change to ingredient X:
SELECT DISTINCT meal_id FROM meal_component WHERE ingredient_id = @X;
```

**Mechanism (eager, scoped):**
1. Bump `ref_revision`.
2. Trigger on `ingredient_nutrients` marks affected `meal_nutrition_mat` rows stale
   (or deletes them).
3. A recompute pass rebuilds those rows from the live view, in a transaction:
   ```sql
   DELETE FROM meal_nutrition_mat WHERE meal_id IN (<affected>);
   INSERT INTO meal_nutrition_mat (meal_id, nutrient_id, amount, ref_revision, computed_at)
     SELECT meal_id, nutrient_id, amount, @rev, @now
     FROM gold_meal_nutrition WHERE meal_id IN (<affected>);
   ```
4. Rebuild `daily_nutrition_mat` for the affected days (delete + reinsert those days
   from `meal_nutrition_mat` — avoids incremental drift).

**Backstop (full rebuild):** because gold is a pure function, the always-correct
fallback for small data is a complete rebuild from the view — slow but simple, and the
correctness reference the incremental path is validated against.

**Lazy alternative:** compare `meal_nutrition_mat.ref_revision` to the current
`ref_revision` on read and recompute on access. Hybrid (eager for the affected-meals
query + lazy safety net) is the robust choice.

---

## 7. Materialized-view strategy (SQLite has no `MATERIALIZED VIEW`)

| Read | Strategy | Why |
|---|---|---|
| Single meal's nutrition | **Materialize on write** into `meal_nutrition_mat` | changes only on a discrete event (resolved / edited); recompute is O(components) |
| Daily / weekly dashboard | **Materialize, trigger-maintained** in `daily_nutrition_mat` | avoids re-joining meals×components×ingredients×nutrients per render; cheap offline |
| Ad-hoc / debugging | **Keep the live `VIEW`** | keep as the formula + rebuild source of truth; don't materialize rare reads |

Daily-rollup trigger:

```sql
CREATE TRIGGER trg_meal_nut_to_daily
AFTER INSERT ON meal_nutrition_mat BEGIN
  INSERT INTO daily_nutrition_mat(day, nutrient_id, amount, meal_count)
  SELECT date(m.eaten_at/1000,'unixepoch','localtime'), NEW.nutrient_id, NEW.amount, 1
  FROM meal m WHERE m.id = NEW.meal_id
  ON CONFLICT(day,nutrient_id) DO UPDATE
    SET amount = amount + NEW.amount, meal_count = meal_count + 1;
END;
```

(Single-meal recompute is cleaner in the app layer in one transaction; triggers shine
for the additive daily rollup.)

---

## 8. Migration from current schema

| Today | Becomes |
|---|---|
| `meals` | split → `meal_log` (bronze) + `meal` (silver) |
| `meal_components(component, qty_g)` | `meal_component` + nullable `ingredient_id`, `source`, `confidence` |
| `component_ingredients` | `ingredient_aliases` (generalized) |
| `gold_meal_nutrition` VIEW | kept as the formula; add `meal_nutrition_mat` + `daily_nutrition_mat` |
| — | new: `meal_templates`, `phrase_resolution`, provenance columns, `ref_revision` |

Appkit operations shift to match the UX:
- `log_meal_quick(raw_text, portion_hint?, eaten_at?)` → bronze write only (hot path)
- `resolve_meal(log_id)` → run the pipeline (worker + manual retry)
- `correct_component(...)` → user override; seeds the cache
- `nutrition_for(meal_id)` → reads `meal_nutrition_mat`
- `daily_summary(day | range)` → reads `daily_nutrition_mat`

Both the web UI and the MCP gateway keep hitting the same `:8080` endpoints; the
worker runs in that one process, so resolution state is shared automatically.

---

## 9. Suggested build sequence

1. Bronze capture + status state machine.
2. Local-cache resolution with a seeded template set + Layer 0/1 normalization (fully
   offline; proves the UX).
3. Materialized gold + `daily_summary` endpoint + dashboard.
4. Online LLM/USDA enrichment with caching (purely additive once cache plumbing exists).

---

## 10. Future work / open questions

- **Semantic normalization (Layers 3–4).** Local vs. hosted embedding model; choice of
  similarity threshold; `sqlite-vec` integration; whether LLM canonicalization is worth
  the nondeterminism+latency vs. embeddings alone. Start with Layers 0–2; treat 3–4 as
  an upgrade.
- **Re-resolving history on template changes.** Default is point-in-time (history
  frozen). Need a UX + policy for "this template improved — apply to past N meals?",
  including how to show that a past meal's numbers were revised.
- **Conflicting / drifting external sources.** USDA vs. OFF can disagree per ingredient;
  need a precedence policy and a way to re-pin when a better source appears.
- **Multi-source confidence fusion.** When lexical, embedding, and LLM layers disagree,
  how to combine their confidences rather than just taking the first to clear threshold.
- **Portion estimation beyond S/M/L.** Photo-based portion estimation; per-user learned
  default servings.
- **Normalizer versioning migrations.** When `normalizer_version` bumps, decide whether
  to lazily re-normalize old `phrase_norm` keys or leave them pinned.
- **Incremental daily-rollup correctness under edits/deletes.** The additive trigger
  handles inserts; edits/deletes need decrement logic or per-day rebuild — pick one and
  test adversarially.
- **GC / retention.** `phrase_resolution` and `ingredient_nutrients` cache growth;
  staleness/refresh policy (`fetched_at` TTL) for external nutrition data.

---

## 11. Loading the classification data

How the reference/lookup tables that drive resolution get populated, kept
reproducible, and kept from fighting runtime-acquired data.

### Principles

- **Data out of code.** Reference data lives in declarative, version-controlled files,
  not hardcoded arrays — diffable, reviewable in PRs, editable by non-engineers.
- **Stable IDs** (`ing_chicken`, `tmpl_chicken_bowl`) so re-loads are idempotent.
- **`source` on every row** (`seed | etl | external | llm | user`).
- **Precedence enforced by the loader** so a re-seed never clobbers a user correction
  or a freshly-fetched value.

### Origin of each table

| Table | Primary source | Load time |
|---|---|---|
| `nutrients` | curated list | bundled seed (build) |
| `ingredients` (+ `default_serving_g`) | curated core + USDA ETL | bundled seed (build) |
| `ingredient_nutrients` | USDA FDC ETL, top-N | bundled seed + lazy runtime fill |
| `ingredient_aliases` | curated + LLM batch, reviewed | bundled seed + runtime (user corrections) |
| `meal_templates` / `template_components` | LLM batch over common dishes, reviewed | bundled seed + lazy runtime |
| `phrase_resolution` (seed) | committed aliases for common dishes | bundled seed + runtime cache |

Build-time bakes a good offline first-run; runtime lazily fills the long tail and
caches it. Both write the same tables, distinguished by `source`.

### File layout & format

```
apps/nutrition/data/
  dataset.json             # { dataset_version, ref_revision } — the bump signal
  nutrients.json           # small/nested → JSON
  ingredients.json
  component_mappings.json   # → becomes ingredient_aliases in the richer schema
  ingredient_nutrients.csv # large/flat, USDA-derived → CSV (clean diffs, streams)
```

JSON for nested/small, **CSV for the big flat nutrition matrix**.

### Loader contract

1. **Validate** shape + **referential integrity** (every `template_component` /
   `ingredient_nutrient` references a known ingredient/nutrient) before touching the
   DB — fail loudly on a bad seed.
2. **Load in FK order**: `nutrients → ingredients → ingredient_nutrients → templates
   → template_components → aliases → phrase_resolution`.
3. **Upsert with precedence** — rank sources (`user=4, seed=3, etl/external=2, llm=1`)
   and only overwrite when incoming rank ≥ stored rank, so a re-seed upgrades stale
   `etl`/`llm` values but never overwrites a `user` correction:
   ```sql
   INSERT INTO ingredient_nutrients (...) VALUES (...)
   ON CONFLICT(ingredient_id, nutrient_id) DO UPDATE SET ...
   WHERE source_rank(excluded.source) >= source_rank(ingredient_nutrients.source);
   ```
4. **One transaction** for atomicity.

### Make the seed reproducible, not hand-typed

- `scripts/build-nutrition-seed.ts` — pull top-N foods from USDA FDC → write
  `ingredients.json` + `ingredient_nutrients.csv`. Output committed, re-runnable.
- `scripts/build-templates.ts` — run the LLM **once, offline, in batch** over common
  dish names → candidate templates/aliases → **human review** (the precision gate) →
  commit. Precomputes the head of the distribution so production is all cache hits.

Build scripts are dev-time and network-allowed; the runtime app only reads the
committed output plus its own lazy cache.

### Upgrades tie into recompute (§6)

`dataset.json` carries `ref_revision`. Bumping it + the precedence upserts apply new
reference values, and the recompute path rebuilds affected `meal_nutrition_mat` /
`daily_nutrition_mat` — automatic and deterministic, without disturbing user-corrected
or point-in-time-frozen history.

### Phasing

1. **Done (this commit):** `seed.ts` reads declarative files under `data/` via a
   generic loader with validation + referential-integrity checks + FK-ordered
   idempotent (`INSERT OR IGNORE`) inserts, against the **current** schema. Behavior
   identical to the old hardcoded seed (tests: 6 ingredients / 8 mappings / 30
   nutrient rows, 69/69 green). Source/precedence-ranked upserts are deferred to the
   schema migration that adds `source` columns (tests pin the current table shapes).
2. USDA ETL → larger `ingredient_nutrients.csv`.
3. Offline LLM batch + review → committed `templates.json` / `aliases.json`.
4. Runtime lazy fill (USDA/OFF/LLM) writing the same tables with lower-rank `source`.
```
