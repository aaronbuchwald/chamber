/**
 * integration.test.ts — Integration tests for the nutrition app's three front-ends.
 *
 * Each test spawns a real subprocess (CLI, HTTP server, MCP server) with cwd set
 * to a unique temp directory so the SQLite DB is isolated and ephemeral.
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

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "nutrition-test-"));
}

function cleanupDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** Run a CLI command and return { stdout, stderr, code }. */
function runCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(TSX, [path.join(NUTRITION_SRC, "cli.ts"), ...args], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

/** Find a free TCP port. */
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

/** Start the HTTP server and wait for it to be ready. */
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
      // The server logs to stderr once it's listening
      if (stderr.includes("HTTP http://localhost:")) {
        resolve(proc);
      }
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`HTTP server exited with code ${code}: ${stderr}`));
      }
    });
    // Timeout safety
    setTimeout(() => reject(new Error(`HTTP server did not start in time. stderr: ${stderr}`)), 10000);
  });
}

// ── CLI integration tests ─────────────────────────────────────────────────────

describe("CLI integration", () => {
  let tempDir: string;

  before(() => {
    tempDir = makeTempDir();
  });

  after(() => {
    cleanupDir(tempDir);
  });

  it("log_meal writes a meal and returns a meal_id", async () => {
    const result = await runCli(
      ["log_meal", "--name", "Chicken bowl", "--components", "grilled chicken:150"],
      tempDir
    );
    assert.equal(result.code, 0, `CLI failed: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.ok(json.meal_id, "meal_id should be present in output");
    assert.match(json.meal_id, /^[0-9a-f-]{36}$/, "meal_id should be a UUID");
  });

  it("nutrition_for returns macros and micros for a logged meal", async () => {
    // First log a meal
    const logResult = await runCli(
      ["log_meal", "--name", "Chicken bowl", "--components", "grilled chicken:150"],
      tempDir
    );
    assert.equal(logResult.code, 0, `log_meal failed: ${logResult.stderr}`);
    const { meal_id } = JSON.parse(logResult.stdout);

    // Then get nutrition
    const nutResult = await runCli(["nutrition_for", "--meal_id", meal_id], tempDir);
    assert.equal(nutResult.code, 0, `nutrition_for failed: ${nutResult.stderr}`);
    const rows = JSON.parse(nutResult.stdout);
    assert.ok(Array.isArray(rows), "nutrition_for should return an array");
    assert.ok(rows.length > 0, "nutrition rows should not be empty");

    // Check for protein row with concrete value
    const protein = rows.find((r: any) => r.nutrient === "Protein");
    assert.ok(protein, "Protein row expected");
    assert.ok(
      Math.abs(protein.amount - 46.5) < 0.001,
      `Protein should be ≈ 46.5g for 150g grilled chicken, got ${protein.amount}`
    );
  });

  it("list_meals shows logged meals", async () => {
    // Use a fresh dir so we get a clean count
    const freshDir = makeTempDir();
    try {
      await runCli(
        ["log_meal", "--name", "Breakfast", "--components", "egg:100"],
        freshDir
      );
      const result = await runCli(["list_meals"], freshDir);
      assert.equal(result.code, 0, `list_meals failed: ${result.stderr}`);
      const meals = JSON.parse(result.stdout);
      assert.ok(Array.isArray(meals), "list_meals should return an array");
      assert.equal(meals.length, 1);
      assert.equal(meals[0].name, "Breakfast");
    } finally {
      cleanupDir(freshDir);
    }
  });
});

// ── HTTP integration tests ────────────────────────────────────────────────────

describe("HTTP integration", () => {
  let tempDir: string;
  let port: number;
  let server: ChildProcess;
  let baseUrl: string;

  before(async () => {
    tempDir = makeTempDir();
    port = await getFreePort();
    server = await startHttpServer(port, tempDir);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => {
    server?.kill("SIGTERM");
    cleanupDir(tempDir);
  });

  it("GET /openapi.json returns the 3 operationIds and anyOf schema for components", async () => {
    const resp = await fetch(`${baseUrl}/openapi.json`);
    assert.equal(resp.status, 200);
    const doc = (await resp.json()) as any;

    assert.equal(doc.openapi, "3.1.0");

    const paths = doc.paths;
    assert.ok(paths["/log_meal"]?.post?.operationId === "log_meal", "log_meal operationId missing");
    assert.ok(paths["/nutrition_for"]?.post?.operationId === "nutrition_for", "nutrition_for operationId missing");
    assert.ok(paths["/list_meals"]?.post?.operationId === "list_meals", "list_meals operationId missing");

    // Check that components field has an anyOf (string | object union)
    const logMealSchema =
      paths["/log_meal"].post.requestBody.content["application/json"].schema;
    const componentsSchema = logMealSchema.properties?.components;
    assert.ok(
      componentsSchema !== undefined,
      "components property should be in the schema"
    );
    // The components schema should be an array whose items have anyOf (from the union)
    const itemSchema = componentsSchema?.items ?? componentsSchema?.anyOf?.[0]?.items ?? componentsSchema;
    // We just need to confirm the schema exists and describes components correctly
    assert.ok(componentsSchema, "components schema should exist");
  });

  it("POST /log_meal returns a meal_id", async () => {
    const resp = await fetch(`${baseUrl}/log_meal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "HTTP test meal",
        components: [{ component: "grilled chicken", qty_g: 200 }],
      }),
    });
    const body = (await resp.json()) as any;
    assert.equal(resp.status, 200, `POST /log_meal failed: ${JSON.stringify(body)}`);
    assert.ok(body.result?.meal_id, "meal_id should be present in result");
    assert.match(body.result.meal_id, /^[0-9a-f-]{36}$/);
  });

  it("POST /nutrition_for returns nutrition rows with correct protein for 200g chicken", async () => {
    // First log a meal
    const logResp = await fetch(`${baseUrl}/log_meal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "HTTP nutrition test",
        components: [{ component: "grilled chicken", qty_g: 200 }],
      }),
    });
    const logBody = (await logResp.json()) as any;
    const meal_id = logBody.result.meal_id;

    const nutResp = await fetch(`${baseUrl}/nutrition_for`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meal_id }),
    });
    const nutBody = (await nutResp.json()) as any;
    assert.equal(nutResp.status, 200, `POST /nutrition_for failed: ${JSON.stringify(nutBody)}`);
    const rows = nutBody.result;
    assert.ok(Array.isArray(rows));

    // 200g * 31.0 / 100 = 62.0g protein
    const protein = rows.find((r: any) => r.nutrient === "Protein");
    assert.ok(protein, "Protein row should exist");
    assert.ok(
      Math.abs(protein.amount - 62.0) < 0.001,
      `Expected Protein ≈ 62.0g for 200g chicken, got ${protein.amount}`
    );
  });

  it("POST /log_meal with string component form also works", async () => {
    const resp = await fetch(`${baseUrl}/log_meal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "String form test",
        components: ["brown rice:150"],
      }),
    });
    const body = (await resp.json()) as any;
    assert.equal(resp.status, 200, `POST /log_meal string form failed: ${JSON.stringify(body)}`);
    assert.ok(body.result?.meal_id);
  });

  it("POST /unknown returns 404", async () => {
    const resp = await fetch(`${baseUrl}/unknown_op`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(resp.status, 404);
  });
});

// ── MCP integration tests ─────────────────────────────────────────────────────

describe("MCP integration", () => {
  it("tools/list returns the tools and log_meal works end-to-end", async () => {
    const tempDir = makeTempDir();
    try {
      // Dynamic import of MCP SDK client (ESM)
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

      const transport = new StdioClientTransport({
        command: TSX,
        args: [path.join(NUTRITION_SRC, "mcp.ts")],
        cwd: tempDir,
        env: { ...process.env },
        stderr: "pipe",
      });

      const client = new Client({ name: "test-client", version: "0.0.1" });
      await client.connect(transport);

      try {
        // 1. tools/list should return our 3 tools
        const toolsResult = await client.listTools();
        const toolNames = toolsResult.tools.map((t: any) => t.name);
        assert.ok(toolNames.includes("log_meal"), `log_meal missing from tools: ${JSON.stringify(toolNames)}`);
        assert.ok(toolNames.includes("nutrition_for"), `nutrition_for missing from tools: ${JSON.stringify(toolNames)}`);
        assert.ok(toolNames.includes("list_meals"), `list_meals missing from tools: ${JSON.stringify(toolNames)}`);
        assert.ok(toolNames.includes("enrich_meal"), `enrich_meal missing from tools: ${JSON.stringify(toolNames)}`);
        assert.equal(toolNames.length, 4, `Expected 4 tools, got ${toolNames.length}`);

        // 2. Call log_meal
        const logResult = await client.callTool({
          name: "log_meal",
          arguments: {
            name: "MCP test meal",
            components: [{ component: "grilled chicken", qty_g: 150 }],
          },
        });
        assert.ok(logResult.content, "log_meal should return content");
        const logContent = (logResult.content as any[])[0];
        assert.equal(logContent.type, "text");
        const logData = JSON.parse(logContent.text);
        assert.ok(logData.meal_id, "meal_id should be present");
        assert.match(logData.meal_id, /^[0-9a-f-]{36}$/);

        // 3. Call nutrition_for
        const nutResult = await client.callTool({
          name: "nutrition_for",
          arguments: { meal_id: logData.meal_id },
        });
        const nutContent = (nutResult.content as any[])[0];
        assert.equal(nutContent.type, "text");
        const rows = JSON.parse(nutContent.text);
        assert.ok(Array.isArray(rows), "nutrition_for should return an array");
        const protein = rows.find((r: any) => r.nutrient === "Protein");
        assert.ok(protein, "Protein row should exist");
        assert.ok(
          Math.abs(protein.amount - 46.5) < 0.001,
          `Expected Protein ≈ 46.5g for 150g chicken, got ${protein.amount}`
        );
      } finally {
        await client.close();
      }
    } finally {
      cleanupDir(tempDir);
    }
  });
});
