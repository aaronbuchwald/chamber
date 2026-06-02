# Chamber prototype apps

Three deliberately tiny TypeScript CLI prototypes, built **outside-in** for human
feedback. They are *not* Chamber WASM components yet — the point is to build real,
runnable apps first and then "work backwards" to derive the Chamber interface
(WIT/host) from what these apps actually needed.

| App | Capability it probes | Storage | Run |
|---|---|---|---|
| [`nutrition/`](./nutrition) | Structured Data Store, **medallion** (Bronze→Silver→Gold) | SQLite (`better-sqlite3`) | `cd nutrition && npm install && npm run demo` |
| [`notes/`](./notes) | Markdown doc-store: one rw, no-execute, human-editable `.md` directory | real filesystem dir | `cd notes && npm install && npm run demo` |
| [`todo/`](./todo) | Structured data over inert text + filtered views | single `todos.md` (task-list syntax) | `cd todo && npm install && npm run demo` |

Each app's README documents its CLI. Each subagent also captured notes on the
operations/types it needed — those feed the interface-design step (the `app-review`
bead gate) before the M2 walking skeleton / WIT work begins.

## What they demonstrate

- **nutrition** — logs a meal as free text (`grilled chicken:150`), normalizes
  components to canonical ingredients (Silver), and aggregates macro/micro
  nutrients per meal through a Gold SQL `VIEW`. All SQL is parameterized — the
  injection-safety property Chamber wants to make structural.
- **notes** — enforces `.md`-only + path-traversal rejection at the store
  boundary, stores text verbatim, and stays consistent with direct human edits
  on disk (no cache).
- **todo** — text + a binary checkbox stored as human-editable markdown
  (`- [ ]` / `- [x]`); views filter all / outstanding / completed.
