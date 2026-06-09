# Chamber

A **datagram** is a whole dataset — multiple medallion tables governed by one
access layer — defined as a **proto package**. From that single `.proto`, the
Chamber SDK generates a typed, string-free data-access layer, an MCP server, and
a live WebUI.

This is the `dev` branch: a clean, best-practices restart driven by
[`docs/datagram-v0-plan.md`](docs/datagram-v0-plan.md). The verified proto
contract under [`proto/`](proto/) is the source of truth.

## Layout

```
proto/                 # the contract (chamber.v1 options + nutrition.v1 datagram) — verified, do not gold-plate
packages/              # SDK runtime (@chamber/datagram): gen/ + data handle + proto→ops runner
apps/                  # datagram apps (nutrition: the v0 port)
docs/datagram-v0-plan.md  # the v0 handoff / plan
SPEC.md                # the broader Chamber spec (§7 data store, §11 grants, §12 security)
```

## Prerequisites

- **Node 22** (native `better-sqlite3` requires it — NOT 25):
  ```bash
  nvm install 22 && nvm use 22   # the repo pins this via .nvmrc
  ```

## Quickstart

```bash
nvm use 22
npm install          # installs the toolchain (buf, protoc-gen-es, biome, tsx, typescript)
npm run gen          # buf generate → committed generated code under packages/*/gen
npm run ci           # buf lint + biome + typecheck + tests (what CI runs)
```

## Toolchain

| Concern        | Tool                               |
| -------------- | ---------------------------------- |
| Monorepo       | npm workspaces (`packages/*`, `apps/*`) |
| Proto codegen  | `buf` + `@bufbuild/protoc-gen-es` (committed `gen/`, drift-checked in CI) |
| Lint + format  | Biome                              |
| Types          | TypeScript (strict)                |
| Tests          | `node:test` via `tsx`              |
| CI             | GitHub Actions (`.github/workflows/ci.yml`), Node 22 |

## Status

Foundation scaffolded. The SDK runtime and the nutrition port are built per the
v0 plan; see that doc's §3 acceptance bar and §4 non-goals (binding).
