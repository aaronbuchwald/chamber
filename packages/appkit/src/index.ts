/**
 * appkit — define an app's operations ONCE, serve them everywhere.
 *
 * One registry (name + zod input schema + handler per operation) feeds three
 * generic, write-once front-ends:
 *   - runCli(app, argv)      a CLI (parse+validate argv)
 *   - serveHttp(app, port)   an HTTP API + generated /openapi.json
 *   - serveMcp(app)          a direct, in-process MCP stdio server
 *
 * The generated /openapi.json is also what a runtime OpenAPI->MCP gateway
 * consumes, so MCP can be served via the gateway OR directly (serveMcp) when
 * you want to drop the middleware hop.
 *
 * This registry is the concrete first draft of Chamber's `server` interface:
 * init() -> list<tool-descriptor>, and call-tool dispatch (see SPEC.md §5).
 */
import http from "node:http";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export { z };

export interface Operation {
  /** Tool/command/route name (snake_case). */
  name: string;
  /** Human description — used by CLI help, OpenAPI summary, and MCP tool description. */
  summary: string;
  /** Argument schema — the single source of truth for every front-end. */
  input: z.ZodObject<z.ZodRawShape>;
  /** Implementation over the app's core logic. */
  handler: (args: any) => unknown | Promise<unknown>;
}

export interface AppDef {
  name: string;
  version: string;
  operations: Operation[];
}

export function defineApp(def: AppDef): AppDef {
  return def;
}

/** Accept a single value or a repeated flag as an array (CLI-friendly). */
export function arrayOf<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess(
    (v) => (v === undefined || v === null ? v : Array.isArray(v) ? v : [v]),
    z.array(item)
  );
}

// ───────────────────────────── CLI front-end ──────────────────────────────

function tryJson(v: string): unknown {
  try { return JSON.parse(v); } catch { return v; }
}

/**
 * Parse `--key value`, repeated `--key` => array, bare `--flag` => true, and
 * bare positionals mapped onto the operation's input fields in declaration
 * order (so `add "buy milk"` works as well as `add --text "buy milk"`).
 */
function parseArgs(op: Operation, args: string[]): Record<string, unknown> {
  const flags: Record<string, unknown> = {};
  const positionals: unknown[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) { positionals.push(tryJson(a)); continue; }
    const key = a.slice(2);
    const next = args[i + 1];
    let val: unknown;
    if (next === undefined || next.startsWith("--")) { val = true; }
    else { val = tryJson(next); i++; }
    if (key in flags) {
      const cur = flags[key];
      flags[key] = Array.isArray(cur) ? [...cur, val] : [cur, val];
    } else {
      flags[key] = val;
    }
  }
  // Map leftover positionals onto fields not already set by a flag, in order.
  let p = 0;
  for (const key of Object.keys(op.input.shape)) {
    if (p >= positionals.length) break;
    if (!(key in flags)) flags[key] = positionals[p++];
  }
  return flags;
}

function printResult(result: unknown): void {
  if (result === undefined || result === null) { console.log("ok"); return; }
  if (typeof result === "string") { console.log(result); return; }
  console.log(JSON.stringify(result, null, 2));
}

function printHelp(app: AppDef): void {
  console.log(`${app.name} ${app.version}\n`);
  console.log("Commands:");
  for (const op of app.operations) {
    console.log(`  ${op.name.padEnd(16)} ${op.summary}`);
    const keys = Object.keys(op.input.shape);
    if (keys.length) console.log(`  ${" ".repeat(16)}   args: ${keys.map((k) => `--${k} <v>`).join(" ")}`);
  }
}

export async function runCli(app: AppDef, argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { printHelp(app); return; }
  const op = app.operations.find((o) => o.name === cmd);
  if (!op) { console.error(`Unknown command: ${cmd}\n`); printHelp(app); process.exitCode = 1; return; }
  const parsed = op.input.safeParse(parseArgs(op, rest));
  if (!parsed.success) {
    console.error(`Invalid arguments for "${cmd}":`);
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }
  try { printResult(await op.handler(parsed.data)); }
  catch (e: any) { console.error("Error:", e?.message ?? String(e)); process.exitCode = 1; }
}

// ──────────────────────── HTTP + OpenAPI front-end ─────────────────────────

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Recursively delete boolean `exclusiveMinimum`/`exclusiveMaximum` keywords (draft-04
 *  style) so the schema is valid under both OpenAPI 3.0 and JSON Schema 2020-12. */
function stripBooleanExclusives(node: unknown): void {
  if (Array.isArray(node)) { for (const item of node) stripBooleanExclusives(item); return; }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const key of ["exclusiveMinimum", "exclusiveMaximum"]) {
      if (typeof obj[key] === "boolean") delete obj[key];
    }
    for (const value of Object.values(obj)) stripBooleanExclusives(value);
  }
}

/** Generate an OpenAPI 3.1 document from the registry (one POST op per route). */
export function openApiDoc(app: AppDef): unknown {
  const paths: Record<string, unknown> = {};
  for (const op of app.operations) {
    // Keep the openApi3 target: agentgateway's OpenAPI parser is 3.0-flavored and
    // expects `exclusiveMinimum`/`exclusiveMaximum` to be *booleans* (draft-04 style);
    // a numeric form makes it reject the spec. But the Claude API validates the
    // resulting MCP tool schema against JSON Schema draft 2020-12, where those same
    // keywords must be *numbers* — so the boolean form is rejected downstream.
    // Sidestep the conflict entirely by dropping the boolean exclusive* markers and
    // keeping plain `minimum`/`maximum`, which both layers accept.
    const schema = zodToJsonSchema(op.input, { target: "openApi3", $refStrategy: "none" });
    stripBooleanExclusives(schema);
    paths[`/${op.name}`] = {
      post: {
        operationId: op.name,
        summary: op.summary,
        requestBody: { required: true, content: { "application/json": { schema } } },
        responses: {
          "200": { description: "Success", content: { "application/json": { schema: { type: "object" } } } },
          "400": { description: "Invalid arguments" },
        },
      },
    };
  }
  return { openapi: "3.1.0", info: { title: app.name, version: app.version }, paths };
}

export function serveHttp(app: AppDef, port = Number(process.env.PORT) || 8787): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/openapi.json") return sendJson(res, 200, openApiDoc(app));
    if (req.method === "GET" && url.pathname === "/") {
      return sendJson(res, 200, {
        name: app.name,
        version: app.version,
        operations: app.operations.map((o) => ({ name: o.name, summary: o.summary })),
      });
    }
    if (req.method === "POST") {
      const op = app.operations.find((o) => url.pathname === `/${o.name}`);
      if (!op) return sendJson(res, 404, { error: `Unknown operation: ${url.pathname}` });
      let body: unknown = {};
      const raw = await readBody(req);
      if (raw) { try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: "Invalid JSON body" }); } }
      const args = op.input.safeParse(body);
      if (!args.success) return sendJson(res, 400, { error: "Invalid arguments", issues: args.error.issues });
      try { const result = await op.handler(args.data); return sendJson(res, 200, { result: result ?? null }); }
      catch (e: any) { return sendJson(res, 400, { error: e?.message ?? String(e) }); }
    }
    sendJson(res, 404, { error: "Not found" });
  });
  server.listen(port, () => console.error(`[${app.name}] HTTP http://localhost:${port}  (OpenAPI: /openapi.json)`));
  return server;
}

// ─────────────────────── MCP front-end (in-process) ────────────────────────

export async function serveMcp(app: AppDef): Promise<void> {
  const server = new McpServer({ name: app.name, version: app.version });
  for (const op of app.operations) {
    server.tool(op.name, op.summary, op.input.shape, async (args: any) => {
      const result = await op.handler(args);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text }] };
    });
  }
  await server.connect(new StdioServerTransport());
  console.error(`[${app.name}] MCP (stdio) ready — ${app.operations.length} tools`);
}
