/**
 * sse.test.ts — the HTTP front-end pushes a Server-Sent Event for every write,
 * so embedded live views (e.g. the Obsidian iframe) refresh without polling.
 *
 * Spawns the real HTTP server in an isolated temp dir, opens GET /events, and
 * asserts a write (log_meal) pushes an event while a read (list_meals) stays
 * silent — the latter guards against a reload→list→reload feedback loop.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NUTRITION_SRC = path.resolve(__dirname, "../src");
const TSX = path.resolve(__dirname, "../node_modules/.bin/tsx");

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as any;
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

function startHttpServer(port: number, cwd: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn(TSX, [path.join(NUTRITION_SRC, "http.ts")], {
      cwd,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.includes("HTTP http://localhost:")) resolve(proc);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0 && code !== null) reject(new Error(`HTTP server exited with code ${code}: ${stderr}`));
    });
    setTimeout(() => reject(new Error(`HTTP server did not start in time. stderr: ${stderr}`)), 10000);
  });
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("SSE live push (GET /events)", () => {
  let tempDir: string;
  let port: number;
  let server: ChildProcess;
  let baseUrl: string;

  before(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "nutrition-sse-test-"));
    port = await getFreePort();
    server = await startHttpServer(port, tempDir);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => {
    server?.kill("SIGTERM");
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it("pushes for a write (log_meal) but not for a read (list_meals)", async () => {
    const res = await fetch(`${baseUrl}/events`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Read the next SSE `data:` frame, ignoring `:` comment/heartbeat lines.
    // Resolves to the frame's data payload, or null if `ms` elapses first.
    async function nextDataFrame(ms: number): Promise<string | null> {
      const deadline = Date.now() + ms;
      for (;;) {
        const idx = buffer.indexOf("\n\n");
        if (idx !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (dataLine) return dataLine.slice("data:".length).trim();
          continue; // comment line (": connected" / ": ping") — keep reading
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        const next = await Promise.race([
          reader.read(),
          new Promise<{ timedOut: true }>((r) => setTimeout(() => r({ timedOut: true }), remaining)),
        ]);
        if ("timedOut" in next || next.done) return null;
        buffer += decoder.decode(next.value, { stream: true });
      }
    }

    // 1. A write pushes a MutationEvent naming the op.
    const logResp = await postJson(`${baseUrl}/log_meal`, {
      name: "SSE test meal",
      components: [{ component: "grilled chicken", qty_g: 100 }],
    });
    assert.equal(logResp.status, 200);

    const frame = await nextDataFrame(5000);
    assert.ok(frame, "expected an SSE data frame after log_meal");
    const evt = JSON.parse(frame!);
    assert.equal(evt.op, "log_meal", `unexpected event payload: ${frame}`);
    assert.ok(typeof evt.at === "number", "event should carry a timestamp");

    // 2. A read must NOT push (otherwise a view that re-fetches on each event loops).
    const listResp = await postJson(`${baseUrl}/list_meals`, {});
    assert.equal(listResp.status, 200);
    const none = await nextDataFrame(800);
    assert.equal(none, null, "list_meals (a read) must not push an SSE event");

    await reader.cancel();
  });
});
