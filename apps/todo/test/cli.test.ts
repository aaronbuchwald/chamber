/**
 * Integration tests for the CLI front-end (src/cli.ts).
 *
 * Each test gets its own temp dir set as `cwd` of the spawned process so
 * todos.md is fully isolated.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

// ──── helpers ────────────────────────────────────────────────────────────────

const CLI = path.resolve(__dirname, "../src/cli.ts");
const TSX = path.resolve(__dirname, "../node_modules/.bin/tsx");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function run(args: string[], cwd: string): RunResult {
  const result = spawnSync(TSX, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-cli-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readTodos(dir: string): string {
  const p = path.join(dir, "todos.md");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

// ──── tests ───────────────────────────────────────────────────────────────────

describe("CLI", () => {
  test("add with --text flag", () => {
    const r = run(["add", "--text", "buy milk"], tmpDir);
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("buy milk"), `stdout: ${r.stdout}`);
    assert.ok(readTodos(tmpDir).includes("- [ ] buy milk"));
  });

  test("add with positional argument", () => {
    const r = run(["add", "wash dishes"], tmpDir);
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("wash dishes"), `stdout: ${r.stdout}`);
    assert.ok(readTodos(tmpDir).includes("- [ ] wash dishes"));
  });

  test("complete marks item done", () => {
    run(["add", "buy milk"], tmpDir);
    const r = run(["complete", "--index", "1"], tmpDir);
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("completed"), `stdout: ${r.stdout}`);
    assert.ok(readTodos(tmpDir).includes("- [x] buy milk"));
  });

  test("list --filter incomplete shows only open items", () => {
    run(["add", "task one"], tmpDir);
    run(["add", "task two"], tmpDir);
    run(["complete", "--index", "1"], tmpDir);
    const r = run(["list", "--filter", "incomplete"], tmpDir);
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    // Should show task two but not task one
    assert.ok(r.stdout.includes("task two"), `stdout: ${r.stdout}`);
    assert.ok(!r.stdout.includes("task one"), `stdout should not contain task one: ${r.stdout}`);
  });

  test("list --filter completed shows only done items", () => {
    run(["add", "task one"], tmpDir);
    run(["add", "task two"], tmpDir);
    run(["complete", "--index", "1"], tmpDir);
    const r = run(["list", "--filter", "completed"], tmpDir);
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("task one"), `stdout: ${r.stdout}`);
    assert.ok(!r.stdout.includes("task two"), `stdout should not contain task two: ${r.stdout}`);
  });

  test("complete with out-of-range index exits non-zero with error message", () => {
    run(["add", "only task"], tmpDir);
    const r = run(["complete", "--index", "99"], tmpDir);
    assert.notEqual(r.exitCode, 0, "should exit non-zero");
    // stderr should have a clear error message (not just a crash trace)
    const combined = r.stdout + r.stderr;
    assert.ok(
      combined.includes("99") || combined.toLowerCase().includes("error"),
      `expected error mentioning 99 or 'error'. got stdout=${r.stdout} stderr=${r.stderr}`
    );
  });

  test("complete 99 does NOT crash the model — subsequent add still works", () => {
    // This verifies the process model is intact: the test process itself is fine
    run(["add", "surviving task"], tmpDir);
    const bad = run(["complete", "--index", "99"], tmpDir);
    assert.notEqual(bad.exitCode, 0, "bad complete should fail");
    // Now run a fresh add in the same directory — should succeed
    const good = run(["add", "new task after error"], tmpDir);
    assert.equal(good.exitCode, 0, `add after error failed: ${good.stderr}`);
    assert.ok(readTodos(tmpDir).includes("- [ ] new task after error"));
  });

  test("todos.md is clean human-editable markdown after CLI operations", () => {
    run(["add", "task one"], tmpDir);
    run(["add", "task two"], tmpDir);
    run(["complete", "--index", "1"], tmpDir);
    const content = readTodos(tmpDir);
    // Each line must be blank, a checkbox, or valid markdown
    const lines = content.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      const isCheckbox = /^- \[[ x]\] .+$/.test(line);
      // Allow any markdown heading or prose too
      assert.ok(
        isCheckbox || line.startsWith("#") || line.length > 0,
        `unexpected line: ${JSON.stringify(line)}`
      );
    }
    // Specifically, all content lines must be proper checkbox format for a pure todo file
    for (const line of lines) {
      assert.ok(
        /^- \[[ x]\] .+$/.test(line),
        `line is not clean checkbox markdown: ${JSON.stringify(line)}`
      );
    }
  });
});
