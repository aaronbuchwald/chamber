/**
 * runtime.ts — define a datagram's operations ONCE, serve them everywhere.
 *
 * A cleaned, validator-agnostic port of the original appkit. One registry
 * (name + JSON-Schema + validate + handler per operation) feeds three generic
 * front-ends:
 *   - runCli(app, argv)      a CLI (parse + validate argv)
 *   - serveHttp(app, port)   an HTTP API + /openapi.json + /ui console + /events SSE
 *   - serveMcp(app)          a direct, in-process MCP stdio server
 *
 * Unlike the original, an {@link Operation} validates input through a
 * `validate(body) → args` function paired with a JSON-Schema, rather than a zod
 * object. The datagram runner (see runner.ts) supplies `validate = proto-es
 * fromJson(ReqSchema, …)` and `jsonSchema = protoMessageToJsonSchema(ReqSchema)`,
 * so no value-validation library is needed and the proto contract is the single
 * source of truth.
 */

import { EventEmitter } from "node:events";
import { createReadStream, existsSync, statSync } from "node:fs";
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

export interface AppDef {
  name: string;
  version: string;
  operations: Operation[];
}

export function defineApp(def: AppDef): AppDef {
  return def;
}

// ─────────────────────── operation dispatch + bus ─────────────────────────

/** A state-changing operation completed (emitted for any op marked `mutates`). */
export interface MutationEvent {
  op: string;
  at: number;
}

const operationBus = new EventEmitter();
operationBus.setMaxListeners(0);

/** Subscribe to mutation events. Returns an unsubscribe function. */
export function onMutation(listener: (evt: MutationEvent) => void): () => void {
  operationBus.on("mutation", listener);
  return () => operationBus.off("mutation", listener);
}

/**
 * The single dispatch path every front-end runs operations through, so write
 * behavior is identical no matter the entry point. On a successful *mutating*
 * op it emits a {@link MutationEvent}; the HTTP front-end forwards those to SSE
 * clients (GET /events) so embedded live views refresh without polling.
 *
 * A handler may be synchronous OR return a promise (async handlers resolve a
 * strategy over the network before the atomic write — see the runner). When the
 * result is a promise we await it before emitting the mutation, so the event
 * only fires once the write has actually committed. A synchronous handler stays
 * synchronous (the return value is not a promise), preserving v0 call sites.
 */
export function invokeOperation<A>(op: Operation<A>, args: A): unknown {
  const result = op.handler(args);
  const emit = () => {
    if (op.mutates) {
      operationBus.emit("mutation", { op: op.name, at: Date.now() } satisfies MutationEvent);
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
    printResult(await invokeOperation(op, parsed.value));
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

function serveStatic(res: http.ServerResponse, staticDir: string, pathname: string): boolean {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(staticDir, rel);
  if (resolved !== staticDir && !resolved.startsWith(staticDir + path.sep)) {
    sendJson(res, 403, { error: "Forbidden" });
    return true;
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) return false;
  const type =
    STATIC_CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  createReadStream(resolved).pipe(res);
  return true;
}

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}

/**
 * Generic, dependency-free HTML console for any datagram — auto-generates a form
 * per operation from its JSON-Schema, runs it against the live HTTP routes, and
 * renders results as tables. It subscribes to GET /events (SSE) and re-runs the
 * visible read forms whenever a mutation arrives — that is the v0 live WebUI:
 * a write from ANOTHER front-end (the MCP tool, the CLI through this process)
 * refreshes open views without a manual reload.
 */
export function uiHtml(app: AppDef): string {
  const ops = app.operations.map((op) => ({
    name: op.name,
    summary: op.summary,
    mutates: op.mutates,
    schema: op.jsonSchema,
  }));
  const data = JSON.stringify({ name: app.name, version: app.version, operations: ops });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(app.name)} — console</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --accent:#2563eb; --card:#f9fafb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#1e1e1e; --fg:#e5e5e5; --muted:#9ca3af; --line:#333; --accent:#60a5fa; --card:#262626; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:10px; position:sticky; top:0; background:var(--bg); }
  header h1 { margin:0; font-size:18px; } header .v { color:var(--muted); font-size:12px; }
  header .live { margin-left:auto; font-size:12px; color:var(--muted); }
  header .live.on { color:#16a34a; }
  main { padding:16px 20px; max-width:1100px; }
  .op { border:1px solid var(--line); border-radius:8px; margin-bottom:16px; overflow:hidden; }
  .op > summary { cursor:pointer; padding:12px 14px; background:var(--card); font-weight:600; list-style:none; }
  .op > summary .s { font-weight:400; color:var(--muted); margin-left:8px; }
  .op-body { padding:14px; }
  .field { margin-bottom:10px; } .field label { display:block; font-size:12px; color:var(--muted); margin-bottom:3px; }
  .field input, .field textarea { width:100%; padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); font:inherit; }
  .field textarea { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; min-height:64px; }
  button.run { padding:7px 16px; border:none; border-radius:6px; background:var(--accent); color:#fff; cursor:pointer; font:inherit; }
  .out { margin-top:12px; }
  table { border-collapse:collapse; width:100%; font-size:13px; } th,td { border:1px solid var(--line); padding:6px 9px; text-align:left; vertical-align:top; }
  th { background:var(--card); }
  pre { background:var(--card); padding:10px; border-radius:6px; overflow:auto; margin:0; }
  .err { color:#ef4444; }
</style>
</head>
<body>
<header><h1>${esc(app.name)}</h1><span class="v">v${esc(app.version)}</span><span class="live" id="live">○ live</span></header>
<main id="app"></main>
<script>
const APP = ${data};
const $ = (t, a={}, ...kids) => { const e = document.createElement(t); for (const k in a) k==="class"?e.className=a[k]:e.setAttribute(k,a[k]); for (const c of kids) e.append(c); return e; };
function fmt(col,v){ if(typeof v==="number"&&/_at$/.test(col)&&v>1e12) return new Date(v).toLocaleString(); if(v&&typeof v==="object") return JSON.stringify(v); return String(v); }
function renderResult(box, payload){
  box.innerHTML="";
  if(payload && payload.error){ box.append($("div",{class:"err"}, payload.error + (payload.issues? " — "+JSON.stringify(payload.issues):""))); return; }
  let r = payload && "result" in payload ? payload.result : payload;
  if(Array.isArray(r) && r.length && r.every(x=>x&&typeof x==="object"&&!Array.isArray(x))){
    const cols=[...new Set(r.flatMap(o=>Object.keys(o)))];
    const tbl=$("table"); const tr=$("tr"); cols.forEach(c=>tr.append($("th",{},c))); tbl.append(tr);
    r.forEach(o=>{ const row=$("tr"); cols.forEach(c=>row.append($("td",{}, fmt(c,o[c])))); tbl.append(row); });
    box.append(tbl);
  } else if(Array.isArray(r) && r.length===0){ box.append($("div",{class:"err"},"(no rows)")); }
  else if(r && typeof r==="object"){ const tbl=$("table"); for(const k in r){ const row=$("tr"); row.append($("th",{},k)); row.append($("td",{}, fmt(k,r[k]))); tbl.append(row); } box.append(tbl); }
  else { box.append($("pre",{}, JSON.stringify(r,null,2))); }
}
function unwrap(p){ return p && p.oneOf ? (p.oneOf.find(o=>o.type!=="string")||p.oneOf[0]) : p; }
async function run(op, form, box){
  const props=(op.schema.properties)||{}; const body={};
  for(const key in props){ const el=form.querySelector('[name="'+key+'"]'); if(!el) continue; const p=unwrap(props[key]);
    if(el.type==="checkbox"){ body[key]=el.checked; continue; }
    const raw=el.value.trim(); if(raw===""){ continue; }
    if(el.dataset.json==="1"){ try{ body[key]=JSON.parse(raw); }catch(e){ renderResult(box,{error:"Field '"+key+"' must be valid JSON"}); return; } }
    else if(p.type==="number"||p.type==="integer"){ body[key]= Number(raw); }
    else { body[key]=raw; }
  }
  box.innerHTML="…";
  try{ const resp=await fetch("/"+op.name,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); renderResult(box, await resp.json()); }
  catch(e){ renderResult(box,{error:String(e)}); }
}
function fieldEl(key, p){
  const wrap=$("div",{class:"field"}); wrap.append($("label",{}, key)); const s=unwrap(p);
  const complex = s.type==="array"||s.type==="object";
  let inp;
  if(complex){ inp=$("textarea",{name:key,placeholder:'JSON, e.g. [{"component":"egg","qty_g":100}]'}); inp.dataset.json="1"; }
  else if(s.type==="boolean"){ inp=$("input",{type:"checkbox",name:key}); }
  else if(s.type==="number"||s.type==="integer"){ inp=$("input",{type:"number",step:"any",name:key}); }
  else { inp=$("input",{type:"text",name:key}); }
  wrap.append(inp); return wrap;
}
const root=document.getElementById("app");
const readForms=[]; // {op, form, out} for zero-arg read ops, re-run on live events
for(const op of APP.operations){
  const props=op.schema.properties||{}; const keys=Object.keys(props);
  const det=$("details",{class:"op"}); if(keys.length===0) det.setAttribute("open","");
  det.append($("summary",{}, op.name, $("span",{class:"s"}, op.summary)));
  const body=$("div",{class:"op-body"}); const form=$("form");
  keys.forEach(k=>form.append(fieldEl(k, props[k])));
  const out=$("div",{class:"out"}); const btn=$("button",{type:"submit",class:"run"},"Run");
  form.append(btn); form.onsubmit=(e)=>{ e.preventDefault(); run(op, form, out); };
  body.append(form, out); det.append(body); root.append(det);
  if(keys.length===0 && !op.mutates){ run(op, form, out); readForms.push({op, form, out}); }
}
// Live view: on any mutation event, re-run the visible zero-arg read forms.
try {
  const es = new EventSource("/events");
  const live = document.getElementById("live");
  es.onopen = () => { live.textContent="● live"; live.className="live on"; };
  es.onerror = () => { live.textContent="○ live"; live.className="live"; };
  es.onmessage = () => { for(const r of readForms) run(r.op, r.form, r.out); };
} catch (e) { /* no EventSource (non-browser); fine */ }
</script>
</body>
</html>`;
}

export interface ServeHttpOptions {
  staticDir?: string;
}

export function serveHttp(
  app: AppDef,
  port = Number(process.env.PORT) || 8787,
  opts: ServeHttpOptions = {},
): http.Server {
  const staticDir = opts.staticDir ? path.resolve(opts.staticDir) : undefined;
  const metadata = () => ({
    name: app.name,
    version: app.version,
    ui: "/ui",
    operations: app.operations.map((o) => ({ name: o.name, summary: o.summary })),
  });

  // Live push: forward every mutation in this process — the UI's own writes AND
  // gateway/MCP writes routed to these HTTP routes — to all connected SSE clients.
  const sseClients = new Set<http.ServerResponse>();
  const unsubscribe = onMutation((evt) => {
    const frame = `data: ${JSON.stringify(evt)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(frame);
      } catch {
        /* client gone; dropped on its close handler */
      }
    }
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/ui") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(uiHtml(app));
    }
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      const heartbeat = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          /* dropped on close */
        }
      }, 30_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/openapi.json") {
      return sendJson(res, 200, openApiDoc(app));
    }
    if (req.method === "GET") {
      if (staticDir) {
        if (url.pathname === "/info") return sendJson(res, 200, metadata());
        if (serveStatic(res, staticDir, url.pathname)) return;
      } else if (url.pathname === "/") {
        return sendJson(res, 200, metadata());
      }
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
        const result = await invokeOperation(op, parsed.value);
        return sendJson(res, 200, { result: result ?? null });
      } catch (e) {
        return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    sendJson(res, 404, { error: "Not found" });
  });
  server.on("close", unsubscribe);
  server.listen(port, () =>
    console.error(`[${app.name}] HTTP http://localhost:${port}  (OpenAPI: /openapi.json, UI: /ui)`),
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
      const result = await invokeOperation(op, parsed.value);
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
  http?: { port?: number; staticDir?: string } | false;
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
    const { port, staticDir } = opts.http ?? {};
    const server = serveHttp(app, port, staticDir ? { staticDir } : {});
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  }
  if (opts.mcp) {
    // Connects the MCP stdio transport; it keeps running alongside the HTTP server.
    await serveMcp(app);
  }
  return {
    async close() {
      for (const c of closers) await c();
    },
  };
}
