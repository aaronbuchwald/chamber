/**
 * integration.test.ts — CLI, HTTP, and MCP front-end integration tests.
 *
 * Each test group uses an isolated CHAMBER_NOTES_ROOT temp directory.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

// ── Path helpers ─────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");
const CLI_SCRIPT = path.join(APP_ROOT, "src", "cli.ts");
const HTTP_SCRIPT = path.join(APP_ROOT, "src", "http.ts");
const MCP_SCRIPT = path.join(APP_ROOT, "src", "mcp.ts");
const TSX = path.join(APP_ROOT, "node_modules", ".bin", "tsx");

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "notes-inttest-"));
}
function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Free port helper ─────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI tests
// ─────────────────────────────────────────────────────────────────────────────

describe("CLI integration", () => {
  let root: string;
  before(() => { root = makeTempRoot(); });
  after(() => rmrf(root));

  /** Run the CLI synchronously and return { stdout, stderr, status }. */
  function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(TSX, [CLI_SCRIPT, ...args], {
      env: { ...process.env, CHAMBER_NOTES_ROOT: root },
      encoding: "utf-8",
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
    };
  }

  test("write then read round-trip", () => {
    const writeResult = runCli(["write", "hello.md", "# Hi"]);
    assert.equal(writeResult.status, 0, `write failed: ${writeResult.stderr}`);

    const readResult = runCli(["read", "hello.md"]);
    assert.equal(readResult.status, 0, `read failed: ${readResult.stderr}`);
    assert.equal(readResult.stdout.trim(), "# Hi");
  });

  test("list returns written file", () => {
    // hello.md was written in previous test; run in same root
    const listResult = runCli(["list"]);
    assert.equal(listResult.status, 0, `list failed: ${listResult.stderr}`);
    assert.match(listResult.stdout, /hello\.md/);
  });

  test("write bad.js exits non-zero with clear error", () => {
    const result = runCli(["write", "bad.js", "x"]);
    assert.notEqual(result.status, 0, "should exit non-zero for rejected extension");
    // Error message should appear in stderr
    const combined = result.stderr + result.stdout;
    assert.ok(
      /\.js|extension|only|allowed|markdown/i.test(combined),
      `expected descriptive error message, got: ${combined}`
    );
  });

  test("write nested path creates file", () => {
    const result = runCli(["write", "ideas/todo.md", "# Todo"]);
    assert.equal(result.status, 0, `failed: ${result.stderr}`);

    const readResult = runCli(["read", "ideas/todo.md"]);
    assert.equal(readResult.status, 0);
    assert.equal(readResult.stdout.trim(), "# Todo");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP tests
// ─────────────────────────────────────────────────────────────────────────────

describe("HTTP integration", () => {
  let root: string;
  let port: number;
  let serverProc: ReturnType<typeof spawn>;

  before(async () => {
    root = makeTempRoot();
    port = await getFreePort();

    serverProc = spawn(TSX, [HTTP_SCRIPT], {
      env: { ...process.env, CHAMBER_NOTES_ROOT: root, PORT: String(port) },
    });

    // Wait for server to be ready by polling
    await waitForServer(`http://127.0.0.1:${port}/`, 5000);
  });

  after(() => {
    serverProc.kill("SIGTERM");
    rmrf(root);
  });

  /** POST JSON to the HTTP server. */
  async function post(opName: string, body: unknown): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/${opName}`,
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => {
            try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
            catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
          });
        }
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  /** GET a URL. */
  async function get(urlPath: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
        });
      }).on("error", reject);
    });
  }

  test("GET /openapi.json returns spec with 5 operations", async () => {
    const { status, body } = await get("/openapi.json");
    assert.equal(status, 200);
    assert.equal(body.openapi, "3.1.0");
    const paths = Object.keys(body.paths);
    assert.equal(paths.length, 5, `expected 5 paths, got: ${paths.join(", ")}`);
    // Check all 5 ops are present
    for (const op of ["list", "read", "write", "append", "remove"]) {
      assert.ok(paths.includes(`/${op}`), `missing /${op} in openapi paths`);
    }
  });

  test("POST /write creates a note", async () => {
    const { status, body } = await post("write", { path: "test.md", text: "# Test Note" });
    assert.equal(status, 200, `unexpected status: ${JSON.stringify(body)}`);
    assert.match(body.result, /test\.md/);
  });

  test("POST /list returns written file", async () => {
    const { status, body } = await post("list", {});
    assert.equal(status, 200, `unexpected status: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.result), "result should be an array");
    assert.ok(body.result.includes("test.md"), `test.md not in list: ${body.result}`);
  });

  test("POST /read returns file content", async () => {
    const { status, body } = await post("read", { path: "test.md" });
    assert.equal(status, 200, `unexpected status: ${JSON.stringify(body)}`);
    assert.equal(body.result, "# Test Note");
  });

  test("POST /write with non-.md path returns HTTP 400", async () => {
    const { status, body } = await post("write", { path: "bad.js", text: "x" });
    assert.equal(status, 400, `expected 400, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.error, "should have error field");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP tests
// ─────────────────────────────────────────────────────────────────────────────

describe("MCP integration", async () => {
  let root: string;

  before(() => { root = makeTempRoot(); });
  after(() => rmrf(root));

  test("tools/list returns 5 tools and write+read works", async () => {
    // Dynamically import the MCP SDK (it's in the notes app's node_modules)
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

    const transport = new StdioClientTransport({
      command: TSX,
      args: [MCP_SCRIPT],
      env: { ...process.env, CHAMBER_NOTES_ROOT: root },
      stderr: "pipe",
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);

    try {
      // 1. List tools
      const toolsResult = await client.listTools();
      assert.equal(
        toolsResult.tools.length,
        5,
        `expected 5 tools, got: ${toolsResult.tools.map((t) => t.name).join(", ")}`
      );
      const toolNames = toolsResult.tools.map((t) => t.name);
      for (const name of ["list", "read", "write", "append", "remove"]) {
        assert.ok(toolNames.includes(name), `missing tool: ${name}`);
      }

      // 2. Write via MCP
      const writeResult = await client.callTool({ name: "write", arguments: { path: "mcp-test.md", text: "# MCP Hello" } });
      const writeContent = (writeResult.content as Array<{ type: string; text: string }>)[0];
      assert.equal(writeContent.type, "text");
      assert.match(writeContent.text, /mcp-test\.md/);

      // 3. Read back via MCP
      const readResult = await client.callTool({ name: "read", arguments: { path: "mcp-test.md" } });
      const readContent = (readResult.content as Array<{ type: string; text: string }>)[0];
      assert.equal(readContent.type, "text");
      assert.equal(readContent.text, "# MCP Hello");
    } finally {
      await client.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Poll a URL until it responds or timeout is reached. */
function waitForServer(url: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      http.get(url, (res) => {
        res.resume();
        resolve();
      }).on("error", () => {
        if (Date.now() >= deadline) {
          reject(new Error(`Server at ${url} did not start within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 100);
        }
      });
    }
    attempt();
  });
}
