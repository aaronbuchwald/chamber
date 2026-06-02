/**
 * Integration tests for the MCP front-end (src/mcp.ts).
 *
 * Spawns src/mcp.ts as a subprocess and drives it with the MCP SDK Client +
 * StdioClientTransport. Each test suite uses a fresh temp dir as cwd.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// MCP SDK Client
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ──── helpers ────────────────────────────────────────────────────────────────

const MCP_SRC = path.resolve(__dirname, "../src/mcp.ts");
const TSX = path.resolve(__dirname, "../node_modules/.bin/tsx");

async function createMcpClient(cwd: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: TSX,
    args: [MCP_SRC],
    env: { ...process.env },
    cwd,
  });

  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

function readTodosFile(dir: string): string {
  const p = path.join(dir, "todos.md");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

// ──── test suite ─────────────────────────────────────────────────────────────

describe("MCP server", () => {
  let client: Client;
  let tmpDir: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-mcp-test-"));
    client = await createMcpClient(tmpDir);
  });

  after(async () => {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("tools/list returns exactly 4 tools", async () => {
    const response = await client.listTools();
    const tools = response.tools;
    assert.ok(Array.isArray(tools), "tools should be an array");
    assert.equal(tools.length, 4, `expected 4 tools, got: ${tools.map((t) => t.name)}`);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("add"), `missing 'add'. tools: ${names}`);
    assert.ok(names.includes("complete"), `missing 'complete'. tools: ${names}`);
    assert.ok(names.includes("reopen"), `missing 'reopen'. tools: ${names}`);
    assert.ok(names.includes("list"), `missing 'list'. tools: ${names}`);
  });

  test("add tool adds a todo item", async () => {
    const result = await client.callTool({ name: "add", arguments: { text: "buy milk" } });
    assert.ok(result.content, "expected content in result");
    const content = result.content as Array<{ type: string; text: string }>;
    assert.equal(content[0]?.type, "text");
    assert.ok(content[0]?.text?.includes("buy milk"), `text: ${content[0]?.text}`);
    // File should exist and contain the item
    assert.ok(readTodosFile(tmpDir).includes("- [ ] buy milk"));
  });

  test("list tool returns added items", async () => {
    await client.callTool({ name: "add", arguments: { text: "wash dishes" } });
    const result = await client.callTool({ name: "list", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const text = content[0]?.text ?? "";
    // Should include both items we added
    assert.ok(text.includes("buy milk"), `list result missing 'buy milk': ${text}`);
    assert.ok(text.includes("wash dishes"), `list result missing 'wash dishes': ${text}`);
  });

  test("complete then reopen round-trip works", async () => {
    // Start fresh in this test via complete/reopen
    const beforeComplete = await client.callTool({ name: "list", arguments: {} });
    const beforeText = (beforeComplete.content as any)[0]?.text ?? "";

    // Complete item 1
    await client.callTool({ name: "complete", arguments: { index: 1 } });
    const afterComplete = await client.callTool({ name: "list", arguments: { filter: "completed" } });
    const completedText = (afterComplete.content as any)[0]?.text ?? "";
    // There should be at least 1 completed item
    assert.ok(completedText.includes('"done": true') || completedText.includes("done"), `expected done item in completed list: ${completedText}`);

    // Reopen item 1
    await client.callTool({ name: "reopen", arguments: { index: 1 } });
    const afterReopen = await client.callTool({ name: "list", arguments: { filter: "incomplete" } });
    const incompletText = (afterReopen.content as any)[0]?.text ?? "";
    // buy milk should be back in incomplete
    assert.ok(incompletText.includes("buy milk"), `expected buy milk in incomplete after reopen: ${incompletText}`);
  });

  test("todos.md remains clean human-editable markdown after MCP operations", () => {
    const content = readTodosFile(tmpDir);
    assert.ok(content.length > 0, "todos.md should exist");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      assert.ok(
        /^- \[[ x]\] .+$/.test(line),
        `line is not clean checkbox markdown: ${JSON.stringify(line)}`
      );
    }
  });
});
