# Datagram SDK — v0 Plan (handoff)

> **Status:** ready for implementation. The proto contract (`proto/`, `buf.yaml`,
> `buf.gen.yaml`) is already scaffolded and verified (`buf lint` clean, `buf build`
> succeeds). Your job is to build the thin runtime around it and port nutrition.
> **Do not gold-plate** — the "Non-goals" list is binding; everything there is v1.

## 1. What we're building and why

A **datagram** is a whole dataset (multiple medallion tables governed by one
access layer), defined as a **proto package**: a `service` (its actions) + its
messages (source tables and curated views) + `chamber.*` options (read/write
effect, access level, transforms). From that one `.proto`, the SDK generates:

- a **typed, string-free data-access layer** (no SQL crosses the handler boundary),
- an **MCP server** (one tool per action), and
- a **live WebUI** (a write in one front-end updates open views in another).

v0 proves exactly that thesis on one local, offline node, by porting the existing
nutrition app onto it. It deliberately reuses the working `@chamber/appkit`
machinery and adds the smallest possible new surface.

### Design decisions already made (context)

- **Datagram = dataset** (multi-table, one access layer, medallion: Bronze base
  tables → Gold views). Backend-neutral via a resource-ref handle (sqlite is the
  only v0 backend). Language-neutral contract (proto), TS prototype.
- **Access = capability + effect.** Each action is labeled `read`/`write`; the
  service declares an `access` upper bound. v0 enforces this with an inline guard
  in the single invoke path. A `subject` and a swappable policy engine
  (Zanzibar/PBAC) are a deliberate later seam — **not in v0**.
- **Data API = typed string-free** query/write; the host binds params and
  allowlists identifiers against the schema. v0 ships the minimal subset nutrition
  needs (`insert`, `query`-by-equality).
- **Atomicity = each action is its own atomic transaction.**
- **Change feed = invalidation + refetch.** A write broadcasts "something
  changed"; views refetch. v0 reuses appkit's existing in-process SSE-on-mutation
  bus. Durable/resumable change logs, row-level deltas, and a Connect
  `SyncService` stream are v1.
- **Proto is the contract, but the gRPC/Connect *runtime* is deferred.** v0 uses
  proto purely as the IDL + codegen source and serves over appkit's plain
  HTTP/JSON + the existing OpenAPI→gateway path for MCP. Adding a Connect server
  later is purely additive (the proto is unchanged).

## 2. Background — read these first

- `packages/appkit/src/index.ts` — the existing framework. Key exports you will
  reuse **unchanged**: `defineApp`, `Operation` (`{name, summary, input, handler,
  mutates}`), `serveHttp` (HTTP + `/openapi.json` + `/ui` console + `/events`
  SSE), `serveMcp`, `uiHtml`, `onMutation`, `invokeOperation`. Note that
  `serveHttp` **already** pushes a `MutationEvent` to connected SSE clients for any
  op with `mutates: true` — that is the v0 live-view mechanism.
- `apps/nutrition/src/{db.ts,operations.ts,app.ts,seed.ts,strategies.ts}` — the
  current nutrition implementation. Reuse its SQL/seed data as the reference for
  the Gold view and the seeded reference table.
- `SPEC.md` §7 (Structured Data Store: medallion layers, no-SQL-crosses-boundary),
  §11 (manifest/grants), §12 (security model). The datagram is the concrete draft
  of these.
- `proto/` — the **already-written, verified** v0 contract (see §4).

## 3. Scope

### Must prove (the only acceptance bar)
1. A proto datagram drives a generated MCP server and a generated WebUI.
2. Actions are labeled read/write and the label is **enforced in one place**.
3. Handlers touch data only through a **typed, string-free** handle (no SQL text).
4. A **Bronze write shows up in a Gold view**, and the WebUI updates **live**
   when a write arrives from another front-end (e.g. the MCP tool).

### Non-goals (binding — these are v1, do NOT build)
- gRPC/Connect runtime, Connect `SyncService` streaming, WebSocket.
- Durable/resumable change log, `seq` cursors, row-level deltas / CRDT.
- Multi-replica sync, edge/browser-OPFS profiles, extensions/delegated grants.
- `PolicyDecisionPoint` interface, `Subject`, Zanzibar/PBAC.
- `Update`/`Delete` in the data handle; predicate trees beyond single equality.
- A Silver layer or a transform dependency graph (v0 = Bronze + one Gold view;
  any write event → refetch all visible queries).
- View-aware UI / per-day navigator (v0 = appkit's generic console, made live).
- External nutrition enrichment (USDA/CalorieNinjas/LLM). v0 is **offline**:
  seeded reference data only, synchronous handlers.
  **(Relaxed — see §3a.)** An injectable strategy seam + async resolution were
  added after v0; offline remains the default, but online strategies (CalorieNinjas,
  LLM) are now supported.

### 3a. Amendment: injectable nutrition strategies (post-v0)

The "offline / synchronous only" non-goal above was **deliberately relaxed** to make
the way a component gets its nutrient values pluggable, without changing the data
contract (the proto Meal/MealComponent/MealNutrition + NutritionService are untouched —
strategy is purely *how* `component_nutrients` is populated):

- **Strategy seam** (`apps/nutrition/src/strategies.ts`): a `NutritionStrategy` has an
  optional `seed` (pre-seed `component_nutrients` at build time) and an optional async
  `resolve(component)` (dynamic per-component lookup).
  - `offlineStrategy` (default) — supplies the bundled seed, no `resolve`; deterministic,
    keyless, fully synchronous (identical to the original v0 behavior).
  - `calorieNinjasStrategy` / `llmStrategy` — **no seed**; resolve over the network
    (CalorieNinjas REST / Anthropic `claude-opus-4-8`). Selecting one creates
    `component_nutrients` **EMPTY** — the offline seed JSON is never loaded on that path.
- **Async runner change** (`packages/datagram/src/runner.ts`): handlers may now be a
  two-phase `PreparedHandler` — `prepare(req)` runs OUTSIDE the per-write transaction
  (async, network) and `commit(prepared, …)` runs the synchronous DB writes INSIDE it.
  The single-point access guard and the atomic transaction are unchanged; plain sync
  handlers still work (backwards compatible). `invokeOperation` awaits async results.
- **Resolution flow**: `log_meal` resolves each distinct, not-yet-cached component via
  `strategy.resolve` (network, outside the transaction), then atomically inserts the meal
  + components + any new reference rows. Idempotent — "resolve once, replay forever";
  a component the strategy can't resolve (null) simply doesn't contribute nutrition.
- **Selection**: entry points read `NUTRITION_STRATEGY=offline|calorieninjas|llm`
  (default `offline`). The keyed online strategies are covered by `npm run test:live`
  (gated on the relevant API key, so default keyless CI stays green).

## 4. The proto contract (already committed & verified)

Files exist and pass `buf lint` / `buf build`:

- `proto/chamber/v1/options.proto` — three extensions:
  `access` (on `ServiceOptions`), `effect` (on `MethodOptions`), `transform`
  (on `MessageOptions`). Conventions: a message **without** `transform` is a
  Bronze base table (field #1 = primary key); **with** `transform` it is a derived
  Gold view materialized by the referenced SQL file.
- `proto/nutrition/v1/nutrition.proto` — `Meal`, `MealComponent` (Bronze),
  `MealNutrition` (Gold, `transform = "transforms/gold_meal_nutrition.sql"`), the
  request/response messages, and `NutritionService` with `LogMeal` (WRITE),
  `NutritionFor` (READ), `ListMeals` (READ), `access = ACCESS_READ_WRITE`.
- `buf.yaml`, `buf.gen.yaml` — local `protoc-gen-es` codegen into
  `packages/datagram/gen`.

## 5. The new surface to build (keep it thin)

Create `packages/datagram` (`@chamber/datagram`). It needs **four** small pieces.

### 5.1 `gen/` — generated code
`npm i -D @bufbuild/protoc-gen-es @bufbuild/protobuf` then `buf generate` (from
repo root). Produces message classes + service/method descriptors. Read the
`chamber.*` custom options at runtime via proto-es `getOption(desc, extension)`
using the generated `chamber/v1/options_pb` extensions (`access`, `effect`,
`transform`).

### 5.2 `src/data.ts` + `src/backends/sqlite.ts` — typed string-free data handle
Minimal interface (only what nutrition needs):

```ts
type Value = string | number | null;
interface Row { [col: string]: Value }
interface DataHandle {
  insert(table: string, row: Row): void;                                   // Bronze writes
  query(table: string,
        opts?: { eq?: [col: string, val: Value]; orderBy?: [col: string, dir: "asc"|"desc"] }
       ): Row[];                                                           // reads & view reads
}
```

`SqliteBackend` (over `better-sqlite3`):
- Derives the schema from the proto descriptor: each Bronze message → a `CREATE
  TABLE` (field #1 PRIMARY KEY; proto types → sqlite affinities); each Gold message
  → a `CREATE VIEW` whose body is the contents of its `transform` SQL file.
- Compiles `insert`/`query` to **prepared statements with bound params**, and
  **allowlists every table/column identifier** against the derived schema,
  rejecting unknowns. (This is the structural injection-safety guarantee — keep it.)
- Seeds the reference table (see §6) idempotently on open.

### 5.3 `src/runner.ts` — proto → appkit operations (the one chokepoint)
`protoToOperations(service: DescService, backend, handlers): Operation[]` maps each
RPC to an appkit `Operation`:
- `name` = snake_case(method name) (so `LogMeal` → `log_meal`).
- `summary` = the method's leading proto comment (fallback to the method name).
- `input` = the request message — **validate with proto-es `fromJson(ReqSchema,
  body)`** (it throws on bad input; no zod/ajv needed). appkit's `Operation.input`
  is a zod object today; either (a) adapt `serveHttp`/`serveMcp` to accept a
  validator + a JSON-Schema, or (b) wrap the proto JSON-Schema in a thin
  zod-compatible shim. Prefer (a): add an optional `jsonSchema` + `validate` to
  `Operation` and use them when present, falling back to zod otherwise — a small,
  backwards-compatible change to appkit.
- `mutates` = `effect == EFFECT_WRITE`. **This is what drives the live SSE push.**
- `handler` wraps the user handler with the **access guard** and, for writes, a
  **transaction**:

```
wrapped(args):
  if effect == WRITE && serviceAccess != READ_WRITE: throw new Error("forbidden: read-only dataset")
  if effect == WRITE:
     return backend.transaction(() => userHandler(args, { data: backend.handle() }))  // atomic
  else:
     return userHandler(args, { data: backend.readHandle() })
```

(better-sqlite3 transactions are synchronous → v0 handlers are synchronous, which
is fine because v0 enrichment is offline/seeded. **Amended post-v0 (see §3a): async
two-phase handlers are now supported** — network resolution runs outside the atomic
transaction, the synchronous DB writes inside it; the offline default stays synchronous.)

MCP tool input schema: provide a small `protoMessageToJsonSchema(descMessage)`
(~40 lines) covering the types nutrition uses — string, double/int64→number,
bool, `repeated`→array, nested message→object. Used for MCP `inputSchema` and the
OpenAPI request body.

### 5.4 `src/generate/*` — reuse appkit
No new servers. Build the appkit `AppDef` from `protoToOperations(...)` and call
the existing `serveHttp(app, port, { staticDir })` (gives HTTP JSON + `/openapi.json`
+ `/ui` + `/events` SSE) and `serveMcp(app)`. The generic `/ui` console, made live
by the existing `/events` wiring, **is** the v0 generated WebUI.

## 6. Nutrition port (`apps/nutrition`)

Leave the existing `apps/nutrition` untouched (side-by-side comparison). New app:
- `transforms/gold_meal_nutrition.sql` — the Gold view: join `meal_components` →
  seeded `ingredient_nutrients` → aggregate macro/micro totals per meal. Port the
  view body from `apps/nutrition/src/db.ts`.
- `seed/reference.json` (or reuse `apps/nutrition`'s seed) — the ingredient →
  nutrient reference rows. Seeded idempotently by `SqliteBackend`.
- `src/service.ts` — three handlers over the `data` handle:
  - `list_meals` (read): `data.query("meals", { orderBy: ["eaten_at", "desc"] })`.
  - `nutrition_for` (read): `data.query("gold_meal_nutrition", { eq: ["meal_id", meal_id] })`.
  - `log_meal` (write): parse `description` → components (the offline path, or
    accept explicit `components`), then `data.insert("meals", …)` +
    `data.insert("meal_components", …)` inside the action's atomic transaction.
    **Post-v0 (see §3a):** the injected `NutritionStrategy` resolves any uncached
    component OUTSIDE that transaction first; offline supplies the seed and resolves
    nothing.
- `src/{http.ts,mcp.ts,cli.ts}` — three entry points wiring the proto service +
  handlers into `serveHttp` / `serveMcp` / `runCli`, mirroring `apps/nutrition/src`.
- Register `nutrition` in `agentgateway-all.yaml` / `start.sh` analogously to
  the existing nutrition app if you want the gateway MCP path (the MCP write →
  HTTP route → SSE push is how cross-front-end live updates work; see §2).

## 7. Build · run · verify

```bash
nvm use 22                                   # better-sqlite3 needs Node 22, NOT 25
buf lint && buf generate                     # from repo root → packages/datagram/gen
cd packages/datagram && npm i
cd ../../apps/nutrition && npm i && npm run serve   # HTTP + /ui + /events
```

### Acceptance criteria
1. `buf lint` clean; `buf generate` produces `gen/` with readable option accessors.
2. **Injection:** a meal named `'; DROP TABLE meals;--` round-trips as a bound
   param; `meals` survives.
3. **Atomicity:** a handler that throws mid-`log_meal` leaves **no** rows in
   `meals` or `meal_components` (transaction rollback).
4. **Access guard:** flipping the service to `ACCESS_READ` makes `log_meal` return
   a `forbidden` error; reads still work.
5. **Medallion:** after `log_meal`, `nutrition_for` returns macro/micro totals
   computed by the Gold view.
6. **Live view:** with `/ui` open, a `log_meal` issued from the **MCP tool** (or
   CLI through the same HTTP process / gateway) updates the console without manual
   refresh.
7. **MCP:** `tools/list` shows `log_meal`/`nutrition_for`/`list_meals` with valid
   JSON-Schema 2020-12 inputs; `tools/call log_meal` returns a `meal_id`.

## 8. Risks / gotchas
- **Node 22, not 25** (native `better-sqlite3` build).
- Use the **local** `protoc-gen-es` plugin (no network assumption on a fresh box).
- Read proto custom options at runtime via proto-es `getOption` + the generated
  `options_pb` extensions.
- Keep MCP + HTTP coherent for live views as appkit does today: route MCP writes
  through the HTTP process (direct stdio `serveMcp` in a *separate* process has no
  SSE subscribers of its own — that's expected and a v1 concern).
- The only appkit change needed is a small, backwards-compatible `Operation`
  extension to accept a proto JSON-Schema + validator (§5.3). Avoid larger
  refactors.

## 9. What comes after v0 (for context, not implementation)
v1 adds: the Connect/gRPC runtime + a server-streaming `SyncService.Subscribe`; a
durable, resumable change log with `seq` and row-level deltas; the transform DAG
for precise `affected_views`; the `PolicyDecisionPoint` + `Subject` seam; and
view-aware WebUI generation from view hints. v2+ adds multi-replica CRDT sync and
the edge/browser host profiles per `SPEC.md` §8/§10.
