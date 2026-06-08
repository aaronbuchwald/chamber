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
import fs from "node:fs";
import path from "node:path";
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

/** Minimal extension-based content types for the optional static UI. */
const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Serve a file from `staticDir` if the request path safely resolves inside it.
 *  Returns true if the request was handled (file sent or 404 written). */
function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, staticDir: string, pathname: string): boolean {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(staticDir, rel);
  // Path-traversal guard: the resolved path must stay within staticDir.
  if (resolved !== staticDir && !resolved.startsWith(staticDir + path.sep)) {
    sendJson(res, 403, { error: "Forbidden" });
    return true;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;
  const type = STATIC_CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(resolved).pipe(res);
  return true;
}

/**
 * Generic, dependency-free HTML console for any app — auto-generates a form per
 * operation from its JSON schema, runs it against the live HTTP routes, and
 * renders results as tables. Designed to be embedded in a note (e.g. Obsidian
 * Custom Frames / Web Viewer) so the app is viewable without leaving the vault.
 */
export function uiHtml(app: AppDef): string {
  const ops = app.operations.map((op) => ({
    name: op.name,
    summary: op.summary,
    schema: zodToJsonSchema(op.input, { target: "openApi3", $refStrategy: "none" }) as any,
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
  header .reload { margin-left:auto; cursor:pointer; color:var(--accent); background:none; border:none; font-size:13px; }
  main { padding:16px 20px; max-width:1100px; }
  .op { border:1px solid var(--line); border-radius:8px; margin-bottom:16px; overflow:hidden; }
  .op > summary { cursor:pointer; padding:12px 14px; background:var(--card); font-weight:600; list-style:none; }
  .op > summary .s { font-weight:400; color:var(--muted); margin-left:8px; }
  .op-body { padding:14px; }
  .field { margin-bottom:10px; } .field label { display:block; font-size:12px; color:var(--muted); margin-bottom:3px; }
  .field label .req { color:#ef4444; } .field input, .field textarea { width:100%; padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); font:inherit; }
  .field textarea { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; min-height:64px; }
  button.run { padding:7px 16px; border:none; border-radius:6px; background:var(--accent); color:#fff; cursor:pointer; font:inherit; }
  .out { margin-top:12px; }
  table { border-collapse:collapse; width:100%; font-size:13px; } th,td { border:1px solid var(--line); padding:6px 9px; text-align:left; vertical-align:top; }
  th { background:var(--card); } td.click { cursor:pointer; } td.click:hover { color:var(--accent); }
  pre { background:var(--card); padding:10px; border-radius:6px; overflow:auto; margin:0; }
  .err { color:#ef4444; } .toast { position:fixed; bottom:16px; left:50%; transform:translateX(-50%); background:var(--accent); color:#fff; padding:8px 14px; border-radius:6px; opacity:0; transition:opacity .2s; }
  .toast.show { opacity:1; }
</style>
</head>
<body>
<header><h1>${esc(app.name)}</h1><span class="v">v${esc(app.version)}</span><button class="reload" onclick="location.reload()">↻ reload</button></header>
<main id="app"></main>
<div class="toast" id="toast"></div>
<script>
const APP = ${data};
const $ = (t, a={}, ...kids) => { const e = document.createElement(t); for (const k in a) k==="class"?e.className=a[k]:e.setAttribute(k,a[k]); for (const c of kids) e.append(c); return e; };
function toast(msg){ const t=document.getElementById("toast"); t.textContent=msg; t.classList.add("show"); setTimeout(()=>t.classList.remove("show"),1200); }
function fmt(col,v){ if(typeof v==="number"&&/_at$/.test(col)&&v>1e12) return new Date(v).toLocaleString(); if(v&&typeof v==="object") return JSON.stringify(v); return String(v); }
function renderResult(box, payload){
  box.innerHTML="";
  if(payload && payload.error){ box.append($("div",{class:"err"}, payload.error + (payload.issues? " — "+JSON.stringify(payload.issues):""))); return; }
  let r = payload && "result" in payload ? payload.result : payload;
  if(Array.isArray(r) && r.length && r.every(x=>x&&typeof x==="object"&&!Array.isArray(x))){
    const cols=[...new Set(r.flatMap(o=>Object.keys(o)))];
    const tbl=$("table"); const tr=$("tr"); cols.forEach(c=>tr.append($("th",{},c))); tbl.append(tr);
    r.forEach(o=>{ const row=$("tr"); cols.forEach(c=>{ const cell=$("td",{class:"click",title:"click to copy"}, fmt(c,o[c])); cell.onclick=()=>{navigator.clipboard.writeText(String(o[c]??"")); toast("copied: "+c);}; row.append(cell); }); tbl.append(row); });
    box.append(tbl);
  } else if(Array.isArray(r) && r.length===0){ box.append($("div",{class:"err"},"(no rows)")); }
  else if(r && typeof r==="object"){ const tbl=$("table"); for(const k in r){ const row=$("tr"); row.append($("th",{},k)); row.append($("td",{}, fmt(k,r[k]))); tbl.append(row); } box.append(tbl); }
  else { box.append($("pre",{}, JSON.stringify(r,null,2))); }
}
async function run(op, form, box){
  const props=(op.schema.properties)||{}; const required=op.schema.required||[]; const body={};
  for(const key in props){ const el=form.querySelector('[name="'+key+'"]'); if(!el) continue; const p=props[key];
    if(el.type==="checkbox"){ body[key]=el.checked; continue; }
    const raw=el.value.trim(); if(raw===""){ if(required.includes(key)) {} else continue; }
    if(el.dataset.json==="1"){ if(raw==="") continue; try{ body[key]=JSON.parse(raw); }catch(e){ renderResult(box,{error:"Field '"+key+"' must be valid JSON"}); return; } }
    else if(p.type==="number"||p.type==="integer"){ body[key]= raw===""? undefined : Number(raw); }
    else { body[key]=raw; }
  }
  box.innerHTML="…";
  try{ const resp=await fetch("/"+op.name,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); renderResult(box, await resp.json()); }
  catch(e){ renderResult(box,{error:String(e)}); }
}
function fieldEl(key, p, required){
  const wrap=$("div",{class:"field"}); const lbl=$("label",{}, key+(p.description?" — "+p.description:"")); if(required) lbl.append($("span",{class:"req"}," *")); wrap.append(lbl);
  const complex = p.type==="array"||p.type==="object"||p.anyOf||p.oneOf||p.allOf;
  let inp;
  if(complex){ inp=$("textarea",{name:key,placeholder:'JSON, e.g. [{"component":"egg","qty_g":100}]'}); inp.dataset.json="1"; }
  else if(p.type==="boolean"){ inp=$("input",{type:"checkbox",name:key}); }
  else if(p.type==="number"||p.type==="integer"){ inp=$("input",{type:"number",step:"any",name:key}); }
  else { inp=$("input",{type:"text",name:key,placeholder:p.description||""}); }
  wrap.append(inp); return wrap;
}
const root=document.getElementById("app");
for(const op of APP.operations){
  const props=op.schema.properties||{}; const required=op.schema.required||[]; const keys=Object.keys(props);
  const det=$("details",{class:"op"}); if(keys.length===0) det.setAttribute("open","");
  det.append($("summary",{}, op.name, $("span",{class:"s"}, op.summary)));
  const body=$("div",{class:"op-body"}); const form=$("form");
  keys.forEach(k=>form.append(fieldEl(k, props[k], required.includes(k))));
  const out=$("div",{class:"out"}); const btn=$("button",{type:"submit",class:"run"},"Run");
  form.append(btn); form.onsubmit=(e)=>{ e.preventDefault(); run(op, form, out); };
  body.append(form, out); det.append(body); root.append(det);
  if(keys.length===0) run(op, form, out); // auto-run zero-arg ops (e.g. list_meals)
}
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

export interface ServeHttpOptions {
  /** If set, GET requests serve files from this dir (UI), and app metadata moves to GET /info. */
  staticDir?: string;
}

export function serveHttp(
  app: AppDef,
  port = Number(process.env.PORT) || 8787,
  opts: ServeHttpOptions = {}
): http.Server {
  const staticDir = opts.staticDir ? path.resolve(opts.staticDir) : undefined;
  const metadata = () => ({
    name: app.name,
    version: app.version,
    ui: "/ui",
    operations: app.operations.map((o) => ({ name: o.name, summary: o.summary })),
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/ui") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(uiHtml(app));
    }
    if (req.method === "GET" && url.pathname === "/openapi.json") return sendJson(res, 200, openApiDoc(app));
    if (req.method === "GET") {
      // With a static UI, metadata lives at /info and GET serves the UI; otherwise / is metadata.
      if (staticDir) {
        if (url.pathname === "/info") return sendJson(res, 200, metadata());
        if (serveStatic(req, res, staticDir, url.pathname)) return;
      } else if (url.pathname === "/") {
        return sendJson(res, 200, metadata());
      }
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
