/**
 * runtime.ts — define a datagram's operations ONCE, serve them everywhere.
 *
 * A cleaned, validator-agnostic port of the original appkit. One registry
 * (name + JSON-Schema + validate + handler per operation) feeds three generic
 * front-ends:
 *   - runCli(app, argv)      a CLI (parse + validate argv)
 *   - serveHttp(app, port)   an HTTP API + /openapi.json + /events SSE (+ optional /ui)
 *   - serveMcp(app)          a direct, in-process MCP stdio server
 *
 * The SDK carries NO UI of its own: a front-end is mounted at GET /ui only when
 * the caller passes a `ui` option (a static dir, or a pre-rendered HTML string —
 * e.g. the generic `@chamber/console` component). The UI layer is a separate
 * component from this datagram layer.
 *
 * Unlike the original, an {@link Operation} validates input through a
 * `validate(body) → args` function paired with a JSON-Schema, rather than a zod
 * object. The datagram runner (see runner.ts) supplies `validate = proto-es
 * fromJson(ReqSchema, …)` and `jsonSchema = protoMessageToJsonSchema(ReqSchema)`,
 * so no value-validation library is needed and the proto contract is the single
 * source of truth.
 */

import { EventEmitter } from "node:events";
import { createReadStream, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchema } from "./jsonschema.js";

/** Validation outcome: either parsed args or a list of error messages. */
export type ValidateResult<A> = { ok: true; value: A } | { ok: false; errors: string[] };

export interface Operation<A = unknown> {
  /** Tool/command/route name (snake_case). */
  name: string;
  /** Human description — CLI help, OpenAPI summary, MCP tool description. */
  summary: string;
  /** Input contract for every front-end (MCP inputSchema + OpenAPI request body + UI form). */
  jsonSchema: JsonSchema;
  /** Validate a raw JSON body into the handler's argument type (proto-es fromJson under the hood). */
  validate: (body: unknown) => ValidateResult<A>;
  /**
   * Implementation over the dataset. Returns the handler's result directly, or a
   * promise of it when the handler resolves a strategy over the network before
   * its atomic write (see the runner's two-phase handlers). Synchronous handlers
   * return a plain value, so the v0 sync dispatch path is unchanged.
   */
  handler: (args: A) => unknown;
  /** Whether this op changes state. Mutating ops broadcast on the bus so live views refresh. */
  mutates: boolean;
}

/** A state-changing operation completed (emitted for any op marked `mutates`). */
export interface MutationEvent {
  op: string;
  at: number;
}

/**
 * The per-app mutation bus key. Each {@link AppDef} carries its OWN EventEmitter
 * under this symbol, so two datagrams composed in one process never cross-fire
 * each other's mutation events — an SSE client of app A only sees A's writes.
 * It is a non-enumerable symbol field so `JSON.stringify(app)` and the UI's
 * metadata serialization stay clean.
 */
const BUS = Symbol("datagram.mutationBus");

export interface AppDef {
  name: string;
  version: string;
  operations: Operation[];
  /** The app's private mutation bus (set by {@link defineApp}); accessed via {@link appBus}. */
  readonly [BUS]?: EventEmitter;
}

export function defineApp(def: AppDef): AppDef {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  // Non-enumerable so it doesn't leak into JSON/console serializations of the app.
  Object.defineProperty(def, BUS, { value: bus, enumerable: false });
  return def;
}

// ─────────────────────── operation dispatch + bus ─────────────────────────

/** The app's mutation bus, lazily created for apps not built via {@link defineApp}. */
function appBus(app: AppDef): EventEmitter {
  let bus = app[BUS];
  if (!bus) {
    bus = new EventEmitter();
    bus.setMaxListeners(0);
    Object.defineProperty(app, BUS, { value: bus, enumerable: false, configurable: true });
  }
  return bus;
}

/** Subscribe to an app's mutation events. Returns an unsubscribe function. */
export function onMutation(app: AppDef, listener: (evt: MutationEvent) => void): () => void {
  const bus = appBus(app);
  bus.on("mutation", listener);
  return () => bus.off("mutation", listener);
}

/**
 * The single dispatch path every front-end runs operations through, so write
 * behavior is identical no matter the entry point. On a successful *mutating*
 * op it emits a {@link MutationEvent} on THIS app's bus; the HTTP front-end
 * forwards those to that app's SSE clients (GET /events) so embedded live views
 * refresh without polling. Scoping the bus to `app` keeps two datagrams in one
 * process isolated — a write on app A never refreshes app B's views.
 *
 * A handler may be synchronous OR return a promise (async handlers resolve a
 * strategy over the network before the atomic write — see the runner). When the
 * result is a promise we await it before emitting the mutation, so the event
 * only fires once the write has actually committed. A synchronous handler stays
 * synchronous (the return value is not a promise), preserving v0 call sites.
 */
export function invokeOperation<A>(app: AppDef, op: Operation<A>, args: A): unknown {
  const result = op.handler(args);
  const emit = () => {
    if (op.mutates) {
      appBus(app).emit("mutation", { op: op.name, at: Date.now() } satisfies MutationEvent);
    }
  };
  if (result instanceof Promise) {
    return result.then((value) => {
      emit();
      return value;
    });
  }
  emit();
  return result;
}

// ───────────────────────────── CLI front-end ──────────────────────────────

function tryJson(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** Parse `--key value`, repeated `--key` → array, bare `--flag` → true, plus positionals. */
function parseArgs(op: Operation, args: string[]): Record<string, unknown> {
  const flags: Record<string, unknown> = {};
  const positionals: unknown[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith("--")) {
      positionals.push(tryJson(a));
      continue;
    }
    const key = a.slice(2);
    const next = args[i + 1];
    let val: unknown;
    if (next === undefined || next.startsWith("--")) {
      val = true;
    } else {
      val = tryJson(next);
      i++;
    }
    const cur = flags[key];
    if (key in flags) flags[key] = Array.isArray(cur) ? [...cur, val] : [cur, val];
    else flags[key] = val;
  }
  let p = 0;
  for (const key of Object.keys(op.jsonSchema.properties ?? {})) {
    if (p >= positionals.length) break;
    if (!(key in flags)) flags[key] = positionals[p++];
  }
  return flags;
}

function printResult(result: unknown): void {
  if (result === undefined || result === null) {
    console.log("ok");
    return;
  }
  if (typeof result === "string") {
    console.log(result);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

function printHelp(app: AppDef): void {
  console.log(`${app.name} ${app.version}\n`);
  console.log("Commands:");
  for (const op of app.operations) {
    console.log(`  ${op.name.padEnd(16)} ${op.summary}`);
    const keys = Object.keys(op.jsonSchema.properties ?? {});
    if (keys.length) {
      console.log(`  ${" ".repeat(16)}   args: ${keys.map((k) => `--${k} <v>`).join(" ")}`);
    }
  }
}

export async function runCli(app: AppDef, argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp(app);
    return;
  }
  const op = app.operations.find((o) => o.name === cmd);
  if (!op) {
    console.error(`Unknown command: ${cmd}\n`);
    printHelp(app);
    process.exitCode = 1;
    return;
  }
  const parsed = op.validate(parseArgs(op, rest));
  if (!parsed.ok) {
    console.error(`Invalid arguments for "${cmd}":`);
    for (const issue of parsed.errors) console.error(`  - ${issue}`);
    process.exitCode = 1;
    return;
  }
  try {
    // Async handlers (online strategies resolving over the network) return a
    // promise; await resolves it, and is a no-op for synchronous handlers.
    printResult(await invokeOperation(app, op, parsed.value));
  } catch (e) {
    console.error("Error:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}

// ──────────────────────── HTTP + OpenAPI front-end ─────────────────────────

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Generate an OpenAPI 3.1 document from the registry (one POST op per route). */
export function openApiDoc(app: AppDef): unknown {
  const paths: Record<string, unknown> = {};
  for (const op of app.operations) {
    paths[`/${op.name}`] = {
      post: {
        operationId: op.name,
        summary: op.summary,
        requestBody: {
          required: true,
          content: { "application/json": { schema: op.jsonSchema } },
        },
        responses: {
          "200": {
            description: "Success",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "400": { description: "Invalid arguments" },
        },
      },
    };
  }
  return { openapi: "3.1.0", info: { title: app.name, version: app.version }, paths };
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * Serve a file out of `staticDir` for `rel` (already prefix-stripped, e.g. "" for
 * the mount root → index.html, or "app.js" for an asset). Returns true if it
 * handled the request (served a file or sent a 403), false to fall through.
 * Keeps the traversal guard: a resolved path must stay inside `staticDir`.
 */
function serveStatic(res: http.ServerResponse, staticDir: string, relPath: string): boolean {
  const rel = relPath === "" ? "index.html" : relPath.replace(/^\/+/, "");
  const resolved = path.resolve(staticDir, rel);
  if (resolved !== staticDir && !resolved.startsWith(staticDir + path.sep)) {
    sendJson(res, 403, { error: "Forbidden" });
    return true;
  }
  // One stat in a try/catch: ENOENT (or any stat failure) → not a file we serve,
  // so fall through. Avoids the prior existsSync+statSync double stat + TOCTOU gap.
  let isFile = false;
  try {
    isFile = statSync(resolved).isFile();
  } catch {
    return false;
  }
  if (!isFile) return false;
  const type =
    STATIC_CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  createReadStream(resolved).pipe(res);
  return true;
}

/**
 * How a UI is mounted at GET /ui. The SDK ships no UI of its own; the caller
 * supplies one of:
 *   - `{ dir }`  — serve `index.html` at /ui and sibling assets at /ui/* from a
 *                  static directory (a no-build front-end component).
 *   - `{ html }` — serve a pre-rendered HTML string at /ui (e.g. how an app opts
 *                  into the generic console: `ui: { html: consoleHtml(app) }`).
 * With no `ui` option, GET /ui is a 404 — the datagram layer stays UI-free.
 */
export type UiMount = { dir: string } | { html: string };

export interface ServeHttpOptions {
  /** Mount a UI at GET /ui (+ /ui/* assets for the `{ dir }` form). */
  ui?: UiMount;
}

export function serveHttp(
  app: AppDef,
  port = Number(process.env.PORT) || 8787,
  opts: ServeHttpOptions = {},
): http.Server {
  // The UI is a SEPARATE component, mounted only when the caller asks. `{ dir }`
  // serves a static front-end at /ui (+ /ui/* assets); `{ html }` serves a
  // pre-rendered string. With no `ui` option, /ui is a 404.
  const ui = opts.ui;
  const uiDir = ui && "dir" in ui ? path.resolve(ui.dir) : undefined;
  const uiHtmlString = ui && "html" in ui ? ui.html : undefined;
  const hasUi = uiDir !== undefined || uiHtmlString !== undefined;
  const metadata = () => ({
    name: app.name,
    version: app.version,
    ...(hasUi ? { ui: "/ui" } : {}),
    operations: app.operations.map((o) => ({ name: o.name, summary: o.summary })),
  });

  // Pre-serialize the OpenAPI doc once at setup — it's a pure function of `app`.
  const cachedOpenApi = JSON.stringify(openApiDoc(app), null, 2);

  // Live push: forward every mutation in this process — the UI's own writes AND
  // gateway/MCP writes routed to these HTTP routes — to all connected SSE clients.
  const sseClients = new Set<http.ServerResponse>();
  const unsubscribe = onMutation(app, (evt) => {
    const frame = `data: ${JSON.stringify(evt)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(frame);
      } catch {
        /* client gone; dropped on its close handler */
      }
    }
  });

  // One shared 30s heartbeat over ALL SSE clients, not one timer per connection.
  // It is unref'd so it never keeps the process alive on its own, and cleared
  // when the server closes.
  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(": ping\n\n");
      } catch {
        /* dropped on its close handler */
      }
    }
  }, 30_000);
  heartbeat.unref?.();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Mounted UI component at /ui (+ /ui/* assets for the static-dir form).
    if (req.method === "GET" && (url.pathname === "/ui" || url.pathname.startsWith("/ui/"))) {
      if (uiHtmlString !== undefined && url.pathname === "/ui") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(uiHtmlString);
      }
      if (uiDir !== undefined) {
        const rel = url.pathname === "/ui" ? "" : url.pathname.slice("/ui/".length);
        if (serveStatic(res, uiDir, rel)) return;
      }
      return sendJson(res, 404, { error: "Not found" });
    }
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/openapi.json") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(cachedOpenApi);
    }
    if (req.method === "GET" && url.pathname === "/") {
      return sendJson(res, 200, metadata());
    }
    if (req.method === "POST") {
      const op = app.operations.find((o) => url.pathname === `/${o.name}`);
      if (!op) return sendJson(res, 404, { error: `Unknown operation: ${url.pathname}` });
      let body: unknown = {};
      const raw = await readBody(req);
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { error: "Invalid JSON body" });
        }
      }
      const parsed = op.validate(body);
      if (!parsed.ok)
        return sendJson(res, 400, { error: "Invalid arguments", issues: parsed.errors });
      try {
        // Await covers async handlers (online strategy resolution); a no-op for
        // synchronous ones.
        const result = await invokeOperation(app, op, parsed.value);
        return sendJson(res, 200, { result: result ?? null });
      } catch (e) {
        return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    sendJson(res, 404, { error: "Not found" });
  });
  server.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  server.listen(port, () =>
    console.error(
      `[${app.name}] HTTP http://localhost:${port}  (OpenAPI: /openapi.json${hasUi ? ", UI: /ui" : ""})`,
    ),
  );
  return server;
}

// ─────────────────────── MCP front-end (in-process) ────────────────────────

export async function serveMcp(app: AppDef): Promise<void> {
  const server = mcpServer(app);
  await server.connect(new StdioServerTransport());
  console.error(`[${app.name}] MCP (stdio) ready — ${app.operations.length} tools`);
}

/**
 * Build (but do not connect) the MCP server for an app. We use the low-level
 * {@link Server} and register `tools/list` + `tools/call` handlers directly, so
 * each tool's `inputSchema` is the operation's exact proto-derived JSON-Schema
 * (2020-12) — no zod/value-validation library is involved and the proto contract
 * stays the single source of truth. `tools/call` validates through the same
 * `validate` path and dispatches via {@link invokeOperation} so writes broadcast
 * on the mutation bus. Exposed for tests that drive MCP over an in-memory
 * transport.
 */
export function mcpServer(app: AppDef): Server {
  const server = new Server(
    { name: app.name, version: app.version },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: app.operations.map((op) => ({
      name: op.name,
      description: op.summary,
      inputSchema: op.jsonSchema as Record<string, unknown>,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const op = app.operations.find((o) => o.name === request.params.name);
    if (!op) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown tool: ${request.params.name}` }],
      };
    }
    const parsed = op.validate(request.params.arguments ?? {});
    if (!parsed.ok) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `Invalid arguments: ${parsed.errors.join("; ")}` },
        ],
      };
    }
    try {
      // Await covers async handlers (online strategy resolution); a no-op for
      // synchronous ones.
      const result = await invokeOperation(app, op, parsed.value);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
      };
    }
  });
  return server;
}

// ──────────────────── controller composition (one instance) ────────────────

export interface ServeOptions {
  /** Attach an HTTP controller (default: on). `false` disables it; an object sets its options. */
  http?: { port?: number; ui?: UiMount } | false;
  /** Attach an MCP stdio controller over the SAME app (default: off). */
  mcp?: boolean;
}

/** A running set of controllers; `close()` shuts them all down. */
export interface ServeHandle {
  close(): Promise<void>;
}

/**
 * Compose multiple controllers over ONE built {@link AppDef} in a single process.
 * Every controller dispatches through the same {@link invokeOperation} and the same
 * process mutation bus, so a write arriving on the MCP controller pushes an SSE event
 * to the HTTP controller's `/events` subscribers — cross-front-end live views, in
 * process, no shared DB-file or gateway round-trip required. (The CLI is a separate
 * one-shot entry, not a long-running controller.)
 */
export async function serve(app: AppDef, opts: ServeOptions = {}): Promise<ServeHandle> {
  const closers: Array<() => Promise<void>> = [];
  if (opts.http !== false) {
    const { port, ui } = opts.http ?? {};
    const server = serveHttp(app, port, ui ? { ui } : {});
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  }
  if (opts.mcp) {
    // Connects the MCP stdio transport; it keeps running alongside the HTTP
    // server. Keep the Server so close() tears the transport down too — otherwise
    // a "graceful" shutdown would leave the stdio MCP connection open.
    const mcp = mcpServer(app);
    await mcp.connect(new StdioServerTransport());
    console.error(`[${app.name}] MCP (stdio) ready — ${app.operations.length} tools`);
    closers.push(() => mcp.close());
  }
  return {
    async close() {
      for (const c of closers) await c();
    },
  };
}
