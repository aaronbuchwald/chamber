/**
 * @chamber/console — a generic, dependency-free HTML console for any datagram.
 *
 * This is a UI COMPONENT, not part of the SDK runtime. It depends ONLY on the
 * public {@link AppDef}/{@link Operation} types of `@chamber/datagram` — it never
 * imports the runtime — and renders a self-contained page purely from operation
 * metadata (name + summary + JSON-Schema). An app opts in by mounting the string
 * it returns at GET /ui:
 *
 *   serve(app, { http: { ui: { html: consoleHtml(app) } } })
 *
 * The page auto-generates a form per operation from its JSON-Schema, runs it
 * against the live HTTP routes, renders results as tables, and subscribes to
 * GET /events (SSE) to re-run the visible zero-arg read forms whenever a mutation
 * arrives — that is the v0 live WebUI: a write from ANOTHER front-end (the MCP
 * tool, the CLI through this process) refreshes open views without a reload.
 */

import type { AppDef } from "@chamber/datagram";

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}

/**
 * Render the generic console for an app as a single self-contained HTML string.
 * Pure function of the app's public operation metadata.
 */
export function consoleHtml(app: AppDef): string {
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
