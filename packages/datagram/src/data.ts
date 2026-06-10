/**
 * data.ts — the typed, string-free data-access contract.
 *
 * Handlers touch the dataset ONLY through a {@link DataHandle}: they name a
 * table and (for queries) a single equality predicate + order, never SQL text.
 * The backend binds every value as a parameter and allowlists every table/column
 * identifier against the schema derived from the proto descriptors — that is the
 * structural injection-safety guarantee (no user string is ever concatenated
 * into SQL). v0 ships only the subset nutrition needs: `insert` + `query` by a
 * single equality with optional ordering. `Update`/`Delete` and predicate trees
 * are deliberately out of scope (v1).
 */

/** A column value. v0 stores strings, numbers, and NULLs (proto string / number / int64-as-number). */
export type Value = string | number | null;

/** A row is a flat map of column name → value. */
export interface Row {
  [col: string]: Value;
}

/** Options for {@link DataHandle.insert}. */
export interface InsertOpts {
  /**
   * Conflict policy on a UNIQUE/PRIMARY-KEY collision. `"ignore"` emits
   * `INSERT OR IGNORE`, making the insert idempotent — used for reference-row
   * caching where two concurrent resolutions of the same novel key would
   * otherwise race to a UNIQUE violation. Omitted → a plain `INSERT` that throws
   * on conflict (the default for ordinary append-only rows).
   */
  onConflict?: "ignore";
}

/** Query shape: an optional single-column equality and an optional ordering. */
export interface QueryOpts {
  /** Restrict to rows where `col = val` (bound as a parameter). */
  eq?: [col: string, val: Value];
  /** Order results by a single column. */
  orderBy?: [col: string, dir: "asc" | "desc"];
}

/**
 * The string-free data handle. A read handle rejects `insert` (reads are
 * side-effect free); a write handle permits both. The runner hands writes a
 * write handle inside an atomic transaction and reads a read handle.
 */
export interface DataHandle {
  /**
   * Insert one Bronze row. Throws on an unknown table/column or on a read handle.
   * Pass `{ onConflict: "ignore" }` to make the insert idempotent on a
   * UNIQUE/PK collision (emits `INSERT OR IGNORE`).
   */
  insert(table: string, row: Row, opts?: InsertOpts): void;
  /** Query a base table or a Gold view by an optional single equality + order. */
  query(table: string, opts?: QueryOpts): Row[];
}

/** Derived column metadata for one table/view (used for identifier allowlisting). */
export interface TableSchema {
  /** Table or view name. */
  name: string;
  /** Allowlisted column names. */
  columns: Set<string>;
  /** Whether this is a derived (Gold) view — views are read-only. */
  view: boolean;
}

/**
 * A backend opens a dataset (deriving + creating the schema, seeding reference
 * data) and yields read/write handles plus an atomic transaction wrapper.
 */
export interface Backend {
  /** A read-only handle (insert throws). */
  readHandle(): DataHandle;
  /** A read/write handle (insert permitted). */
  writeHandle(): DataHandle;
  /** Run `fn` inside a single atomic transaction; rolls back if it throws. */
  transaction<T>(fn: () => T): T;
  /** Release underlying resources. */
  close(): void;
}
