/**
 * Integration tests for the HTTP front-end (src/http.ts).
 *
 * Starts the server on a free port for each test suite, pointing its cwd at a
 * temp dir so todos.md is isolated. Shuts down after each suite.
 */
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { spawn, ChildProcess } from "node:child_process";

// ──── helpers ────────────────────────────────────────────────────────────────

const HTTP_SRC = path.resolve(__dirname, "../src/http.ts");
const TSX = path.resolve(__dirname, "../node_modules/.bin/tsx");

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

async function startServer(cwd: string): Promise<{ proc: ChildProcess; port: number; base: string }> {
  const port = await getFreePort();
  const proc = spawn(TSX, [HTTP_SRC], {
    cwd,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for the server to be ready (it logs to stderr)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 15_000);
    proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString();
      if (msg.includes("HTTP") || msg.includes("localhost")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited early with code ${code}`));
    });
  });

  return { proc, port, base: `http://127.0.0.1:${port}` };
}

async function stopServer(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    proc.on("exit", () => resolve());
    proc.kill("SIGTERM");
    setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 3_000);
  });
}

async function post(base: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function get(base: string, path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`);
  const json = await res.json();
  return { status: res.status, json };
}

function readTodosFile(dir: string): string {
  const p = path.join(dir, "todos.md");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

// ──── test suite ─────────────────────────────────────────────────────────────

describe("HTTP server", () => {
  let server: { proc: ChildProcess; port: number; base: string };
  let tmpDir: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-http-test-"));
    server = await startServer(tmpDir);
  });

  after(async () => {
    await stopServer(server.proc);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("GET /openapi.json returns the 4 operations", async () => {
    const { status, json } = await get(server.base, "/openapi.json");
    assert.equal(status, 200);
    assert.ok(json.openapi, "missing openapi field");
    const paths = Object.keys(json.paths);
    assert.ok(paths.includes("/add"), `missing /add. paths: ${paths}`);
    assert.ok(paths.includes("/complete"), `missing /complete. paths: ${paths}`);
    assert.ok(paths.includes("/reopen"), `missing /reopen. paths: ${paths}`);
    assert.ok(paths.includes("/list"), `missing /list. paths: ${paths}`);
    assert.equal(paths.length, 4, `expected 4 paths, got: ${paths}`);
  });

  test("POST /add adds a todo item", async () => {
    const { status, json } = await post(server.base, "/add", { text: "buy milk" });
    assert.equal(status, 200, `body: ${JSON.stringify(json)}`);
    assert.ok(json.result?.includes("buy milk"), `result: ${JSON.stringify(json)}`);
  });

  test("POST /list with filter=incomplete returns open items only", async () => {
    // Add two items, complete one
    await post(server.base, "/add", { text: "item A" });
    await post(server.base, "/add", { text: "item B" });
    await post(server.base, "/complete", { index: 1 });
    // buy milk from previous test is index 1 here (it was added first)
    // Re-add known items for isolation within the shared dir:
    // List incomplete — should NOT include any done items
    const { status, json } = await post(server.base, "/list", { filter: "incomplete" });
    assert.equal(status, 200, `body: ${JSON.stringify(json)}`);
    const items = json.result as Array<{ done: boolean; text: string }>;
    assert.ok(Array.isArray(items), `result should be array: ${JSON.stringify(json)}`);
    for (const item of items) {
      assert.equal(item.done, false, `found completed item in incomplete list: ${JSON.stringify(item)}`);
    }
  });

  test("POST /complete with out-of-range index returns HTTP 400 and server stays up", async () => {
    const { status, json } = await post(server.base, "/complete", { index: 9999 });
    assert.equal(status, 400, `expected 400, got ${status}. body: ${JSON.stringify(json)}`);
    assert.ok(json.error, `expected error field. body: ${JSON.stringify(json)}`);

    // Confirm server is still alive by making a follow-up request
    const { status: s2, json: j2 } = await get(server.base, "/openapi.json");
    assert.equal(s2, 200, `server died after 400 error. Follow-up got ${s2}: ${JSON.stringify(j2)}`);
  });

  test("todos.md is clean human-editable markdown after HTTP operations", async () => {
    // The previous tests have added items and completed some.
    const content = readTodosFile(tmpDir);
    assert.ok(content.length > 0, "todos.md should exist and have content");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      assert.ok(
        /^- \[[ x]\] .+$/.test(line),
        `line is not clean checkbox markdown: ${JSON.stringify(line)}`
      );
    }
  });
});

// ──── isolated test for GET / ─────────────────────────────────────────────────

describe("HTTP server root endpoint", () => {
  let server: { proc: ChildProcess; port: number; base: string };
  let tmpDir: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-http-root-test-"));
    server = await startServer(tmpDir);
  });

  after(async () => {
    await stopServer(server.proc);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("GET / returns app info with 4 operations listed", async () => {
    const { status, json } = await get(server.base, "/");
    assert.equal(status, 200);
    assert.equal(json.name, "todo");
    assert.ok(Array.isArray(json.operations));
    assert.equal(json.operations.length, 4);
  });
});
