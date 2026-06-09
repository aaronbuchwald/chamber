/**
 * sqlite.ts — the better-sqlite3 backend for a datagram.
 *
 * Responsibilities:
 *   1. Derive + create the schema (Bronze tables, reference tables, Gold views)
 *      from the proto descriptors and the transform SQL files.
 *   2. Seed reference tables idempotently on open (INSERT OR IGNORE).
 *   3. Compile `insert`/`query` to PREPARED STATEMENTS with bound params, and
 *      ALLOWLIST every table/column identifier against the derived schema. This
 *      is the structural injection-safety guarantee: no user-supplied string is
 *      ever concatenated into SQL; identifiers come only from the schema, values
 *      only as bound parameters.
 *   4. Expose an atomic `transaction(fn)` (better-sqlite3 is synchronous, so v0
 *      handlers are synchronous).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type { Backend, DataHandle, QueryOpts, Row, TableSchema, Value } from "../data.js";
import { type BronzeTable, type DatasetSchema, type ReferenceTable, allowlist } from "../schema.js";

export interface SqliteOptions {
  /** File path, or `:memory:` for an ephemeral DB (default). */
  path?: string;
  /** Base directory the Gold views' transform paths are resolved against. */
  transformDir?: string;
}

/** Quote a SQLite identifier that has ALREADY been allowlisted against the schema. */
function ident(name: string): string {
  // Belt-and-suspenders: identifiers reaching here are allowlist members, but a
  // double-quote escape keeps the rule total even if the schema ever grows one.
  return `"${name.replace(/"/g, '""')}"`;
}

function columnDdl(columns: BronzeTable["columns"], compositePk?: string[]): string {
  const cols = columns.map((c) => {
    const pk = !compositePk && c.primaryKey ? " PRIMARY KEY" : "";
    return `${ident(c.name)} ${c.affinity}${pk}`;
  });
  if (compositePk && compositePk.length > 0) {
    cols.push(`PRIMARY KEY (${compositePk.map(ident).join(", ")})`);
  }
  return cols.join(", ");
}

export class SqliteBackend implements Backend {
  private readonly db: Database.Database;
  private readonly tables: Map<string, TableSchema>;
  private readonly transformDir: string;

  constructor(schema: DatasetSchema, opts: SqliteOptions = {}) {
    this.db = new Database(opts.path ?? ":memory:");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.transformDir = opts.transformDir ?? process.cwd();
    this.tables = allowlist(schema);
    this.applySchema(schema);
    this.seed(schema.references);
  }

  private applySchema(schema: DatasetSchema): void {
    for (const t of schema.tables) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${ident(t.name)} (${columnDdl(t.columns)});`);
    }
    for (const r of schema.references) {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${ident(r.name)} (${columnDdl(r.columns, r.primaryKey)});`,
      );
    }
    for (const v of schema.views) {
      const body = readFileSync(resolve(this.transformDir, v.transformPath), "utf8").trim();
      // The transform file is host-validated SQL (committed in the repo), not
      // user input. We still wrap it as a named view so callers only ever name
      // the view, never inline SQL.
      this.db.exec(`CREATE VIEW IF NOT EXISTS ${ident(v.name)} AS\n${body};`);
    }
  }

  private seed(references: ReferenceTable[]): void {
    const insertAll = this.db.transaction((refs: ReferenceTable[]) => {
      for (const r of refs) {
        if (r.seed.length === 0) continue;
        const cols = r.columns.map((c) => c.name);
        const stmt = this.db.prepare(
          `INSERT OR IGNORE INTO ${ident(r.name)} (${cols.map(ident).join(", ")}) ` +
            `VALUES (${cols.map((c) => `@${c}`).join(", ")})`,
        );
        for (const row of r.seed) stmt.run(row);
      }
    });
    insertAll(references);
  }

  /** Allowlist a table name, returning its schema or throwing on an unknown table. */
  private requireTable(table: string): TableSchema {
    const t = this.tables.get(table);
    if (!t) throw new Error(`unknown table: ${table}`);
    return t;
  }

  /** Allowlist a column name against a table's schema. */
  private requireColumn(t: TableSchema, column: string): string {
    if (!t.columns.has(column)) throw new Error(`unknown column "${column}" on table "${t.name}"`);
    return column;
  }

  private doInsert(table: string, row: Row): void {
    const t = this.requireTable(table);
    if (t.view) throw new Error(`cannot insert into view "${table}"`);
    const cols = Object.keys(row);
    if (cols.length === 0) throw new Error(`insert into "${table}" with no columns`);
    for (const c of cols) this.requireColumn(t, c);
    const sql =
      `INSERT INTO ${ident(table)} (${cols.map(ident).join(", ")}) ` +
      `VALUES (${cols.map((c) => `@${c}`).join(", ")})`;
    this.db.prepare(sql).run(row);
  }

  private doQuery(table: string, opts: QueryOpts = {}): Row[] {
    const t = this.requireTable(table);
    let sql = `SELECT * FROM ${ident(table)}`;
    const params: Record<string, Value> = {};
    if (opts.eq) {
      const [col, val] = opts.eq;
      this.requireColumn(t, col);
      sql += ` WHERE ${ident(col)} = @eq_val`;
      params.eq_val = val;
    }
    if (opts.orderBy) {
      const [col, dir] = opts.orderBy;
      this.requireColumn(t, col);
      sql += ` ORDER BY ${ident(col)} ${dir === "desc" ? "DESC" : "ASC"}`;
    }
    return this.db.prepare(sql).all(params) as Row[];
  }

  readHandle(): DataHandle {
    return {
      insert: () => {
        throw new Error("forbidden: read-only handle cannot insert");
      },
      query: (table, opts) => this.doQuery(table, opts),
    };
  }

  writeHandle(): DataHandle {
    return {
      insert: (table, row) => this.doInsert(table, row),
      query: (table, opts) => this.doQuery(table, opts),
    };
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

/** Open a SQLite-backed datagram for the given derived schema. */
export function openSqlite(schema: DatasetSchema, opts?: SqliteOptions): SqliteBackend {
  return new SqliteBackend(schema, opts);
}
