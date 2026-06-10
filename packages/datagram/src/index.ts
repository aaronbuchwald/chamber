/**
 * @chamber/datagram — the v0 datagram SDK runtime.
 *
 * From a proto package (a service + its messages + chamber.* options) this SDK
 * derives a typed string-free data layer, an MCP server, and a live WebUI. See
 * docs/datagram-v0-plan.md.
 */

export type {
  Backend,
  DataHandle,
  InsertOpts,
  QueryOpts,
  Row,
  TableSchema,
  Value,
} from "./data.js";
export {
  type BronzeTable,
  type ColumnDef,
  type DatasetSchema,
  type GoldView,
  type ReferenceTable,
  allowlist,
  deriveSchema,
  tableName,
} from "./schema.js";
export { type JsonSchema, protoMessageToJsonSchema } from "./jsonschema.js";
export {
  type Handler,
  type HandlerContext,
  type Handlers,
  type PreparedHandler,
  type RunnerBackend,
  type Summaries,
  type SyncHandler,
  protoToOperations,
} from "./runner.js";
export {
  type AppDef,
  type MutationEvent,
  type Operation,
  type ServeHandle,
  type ServeHttpOptions,
  type ServeOptions,
  type ValidateResult,
  defineApp,
  invokeOperation,
  mcpServer,
  onMutation,
  openApiDoc,
  runCli,
  serve,
  serveHttp,
  serveMcp,
  uiHtml,
} from "./runtime.js";
export { SqliteBackend, type SqliteOptions, openSqlite } from "./backends/sqlite.js";
export { humanize, humanizeField, pluralize, snakeCase } from "./strings.js";
