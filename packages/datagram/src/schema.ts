/**
 * schema.ts — derive a dataset's SQLite schema from the proto descriptors.
 *
 * Convention (chamber.v1 options.proto):
 *   - a message WITHOUT a `transform` option is a Bronze base table; field #1 is
 *     its primary key,
 *   - a message WITH a `transform` option is a derived (Gold) view materialized
 *     by the referenced SQL file.
 *
 * A datagram also needs seeded *reference* tables (e.g. nutrition's
 * component→nutrient matrix) that are not themselves actions' messages. Those
 * are declared by the app as {@link ReferenceTable}s and folded into the same
 * derived schema so the backend can allowlist their identifiers too.
 */

import { type DescMessage, type DescService, ScalarType } from "@bufbuild/protobuf";
import { getOption, hasOption } from "@bufbuild/protobuf";
import { transform } from "../gen/chamber/v1/options_pb.js";
import type { Row, TableSchema } from "./data.js";

/** A column in a derived base-table schema. */
export interface ColumnDef {
  /** snake_case column name (the proto field name). */
  name: string;
  /** SQLite affinity derived from the proto scalar type. */
  affinity: "TEXT" | "INTEGER" | "REAL";
  /** Whether this column is the table's primary key (field #1). */
  primaryKey: boolean;
}

/** A derived Bronze base table. */
export interface BronzeTable {
  kind: "table";
  name: string;
  columns: ColumnDef[];
}

/** A derived Gold view (body is the transform SQL file's contents). */
export interface GoldView {
  kind: "view";
  name: string;
  /** Allowlisted column names (the proto message fields). */
  columns: string[];
  /** Relative path to the SQL transform file (from the message option). */
  transformPath: string;
}

/**
 * A seeded reference table the dataset depends on but that is not a proto
 * message (e.g. the ingredient→nutrient matrix the Gold view joins). The app
 * declares its DDL columns + idempotent seed rows; the backend creates and
 * seeds it on open.
 */
export interface ReferenceTable {
  kind: "reference";
  name: string;
  /** Column definitions in declaration order. */
  columns: ColumnDef[];
  /** Optional composite primary key (column names); overrides per-column PK. */
  primaryKey?: string[];
  /** Idempotent seed rows (inserted with INSERT OR IGNORE). */
  seed: Row[];
}

/** The full derived schema: Bronze tables, Gold views, and reference tables. */
export interface DatasetSchema {
  tables: BronzeTable[];
  views: GoldView[];
  references: ReferenceTable[];
}

/** Map a proto scalar type to a SQLite affinity. */
function affinityOf(scalar: ScalarType): "TEXT" | "INTEGER" | "REAL" {
  switch (scalar) {
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      return "REAL";
    case ScalarType.INT64:
    case ScalarType.UINT64:
    case ScalarType.INT32:
    case ScalarType.UINT32:
    case ScalarType.SINT32:
    case ScalarType.SINT64:
    case ScalarType.FIXED32:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED32:
    case ScalarType.SFIXED64:
    case ScalarType.BOOL:
      return "INTEGER";
    default:
      return "TEXT";
  }
}

/** The set of RPC input/output messages (the action envelopes), by type name. */
function envelopeNames(service: DescService): Set<string> {
  const names = new Set<string>();
  for (const m of service.methods) {
    names.add(m.input.typeName);
    names.add(m.output.typeName);
  }
  return names;
}

/**
 * Whether a message is a Bronze base table.
 *
 * Per the chamber.v1 convention, a base-table message is a flat (scalar-only)
 * data row with NO `transform` option whose FIELD #1 IS THE PRIMARY KEY, named
 * `id`. That primary-key convention is exactly what separates true tables
 * (`Meal`, `MealComponent` — field #1 `id`) from request/response envelopes and
 * request-only sub-messages (`Component`, `*Request`, `*Response` — whose field
 * #1 is not an `id`). Action envelopes are excluded outright.
 */
function isBronzeTable(msg: DescMessage, envelopes: Set<string>): boolean {
  if (hasOption(msg, transform)) return false;
  if (envelopes.has(msg.typeName)) return false;
  if (msg.fields.length === 0) return false;
  if (!msg.fields.every((f) => f.fieldKind === "scalar")) return false;
  const first = msg.fields.find((f) => f.number === 1);
  return first?.name === "id";
}

/** Derive a Bronze table from a scalar message (field #1 = primary key). */
function bronzeOf(msg: DescMessage): BronzeTable {
  const columns: ColumnDef[] = msg.fields.map((f) => ({
    name: f.name,
    affinity: affinityOf(f.scalar ?? ScalarType.STRING),
    primaryKey: f.number === 1,
  }));
  return { kind: "table", name: tableName(msg), columns };
}

/** Derive a Gold view from a message carrying a `transform` option. The view's
 *  name is the transform file's basename (e.g. `transforms/gold_meal_nutrition.sql`
 *  → `gold_meal_nutrition`), so the curated view reads with its conventional
 *  medallion name; its allowlisted columns are the proto message's fields. */
function goldOf(msg: DescMessage): GoldView {
  const transformPath = getOption(msg, transform);
  const base = transformPath.split("/").pop() ?? transformPath;
  const name = base.replace(/\.sql$/i, "");
  return {
    kind: "view",
    name,
    columns: msg.fields.map((f) => f.name),
    transformPath,
  };
}

/** snake_case table name for a message (e.g. `MealComponent` → `meal_components`). */
export function tableName(msg: DescMessage): string {
  const snake = msg.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return pluralize(snake);
}

/** Naive English pluralization, sufficient for the v0 nutrition names. */
function pluralize(s: string): string {
  if (s.endsWith("s")) return s;
  if (s.endsWith("y")) return `${s.slice(0, -1)}ies`;
  return `${s}s`;
}

/**
 * Derive the dataset schema from the service's message universe plus any
 * app-declared reference tables. Walks every message reachable in the proto
 * file the service lives in; scalar-only messages become Bronze tables, messages
 * with a `transform` become Gold views, and action envelopes are ignored.
 */
export function deriveSchema(
  service: DescService,
  references: ReferenceTable[] = [],
): DatasetSchema {
  const tables: BronzeTable[] = [];
  const views: GoldView[] = [];
  const envelopes = envelopeNames(service);
  for (const msg of service.file.messages) {
    if (hasOption(msg, transform)) views.push(goldOf(msg));
    else if (isBronzeTable(msg, envelopes)) tables.push(bronzeOf(msg));
  }
  return { tables, views, references };
}

/** Flatten the schema into per-name {@link TableSchema} entries for identifier allowlisting. */
export function allowlist(schema: DatasetSchema): Map<string, TableSchema> {
  const map = new Map<string, TableSchema>();
  for (const t of schema.tables) {
    map.set(t.name, { name: t.name, columns: new Set(t.columns.map((c) => c.name)), view: false });
  }
  for (const r of schema.references) {
    map.set(r.name, { name: r.name, columns: new Set(r.columns.map((c) => c.name)), view: false });
  }
  for (const v of schema.views) {
    map.set(v.name, { name: v.name, columns: new Set(v.columns), view: true });
  }
  return map;
}
