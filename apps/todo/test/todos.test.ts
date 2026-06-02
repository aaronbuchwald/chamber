/**
 * Unit tests for todos.ts
 *
 * Each test uses a fresh temp dir (process.chdir) so todos.md stays isolated.
 */
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// We import the module under test AFTER setting up cwd.
// Because todos.ts uses process.cwd() at call time (not module load time),
// we can import once and just chdir before each test.
import { parseTodos, add, setDone, list } from "../src/todos.js";

// ──── helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;
let savedCwd: string;

function freshTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "todos-test-"));
}

function readFile(dir: string): string {
  const p = path.join(dir, "todos.md");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function writeFile(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, "todos.md"), content, "utf8");
}

// ──── parseTodos ─────────────────────────────────────────────────────────────

describe("parseTodos", () => {
  test("parses open checkbox lines", () => {
    const todos = parseTodos(["- [ ] buy milk", "- [ ] wash dishes"]);
    assert.equal(todos.length, 2);
    assert.deepEqual(todos[0], { index: 1, done: false, text: "buy milk" });
    assert.deepEqual(todos[1], { index: 2, done: false, text: "wash dishes" });
  });

  test("parses done checkbox lines", () => {
    const todos = parseTodos(["- [x] buy milk"]);
    assert.equal(todos.length, 1);
    assert.deepEqual(todos[0], { index: 1, done: true, text: "buy milk" });
  });

  test("ignores non-todo lines (headings, blanks, prose)", () => {
    const lines = [
      "# My Todos",
      "",
      "- [ ] task one",
      "Some random prose",
      "- [x] task two",
      "",
    ];
    const todos = parseTodos(lines);
    assert.equal(todos.length, 2);
    assert.deepEqual(todos[0], { index: 1, done: false, text: "task one" });
    assert.deepEqual(todos[1], { index: 2, done: true, text: "task two" });
  });

  test("indexes only checkbox lines (1-based)", () => {
    const lines = ["# Header", "- [ ] first", "- [ ] second", "- [x] third"];
    const todos = parseTodos(lines);
    assert.equal(todos[0].index, 1);
    assert.equal(todos[1].index, 2);
    assert.equal(todos[2].index, 3);
  });

  test("returns empty array for no checkbox lines", () => {
    assert.deepEqual(parseTodos([]), []);
    assert.deepEqual(parseTodos(["# Header", "", "Some text"]), []);
  });
});

// ──── add ─────────────────────────────────────────────────────────────────────

describe("add", () => {
  beforeEach(() => {
    savedCwd = process.cwd();
    tmpDir = freshTmp();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates todos.md when it does not exist", () => {
    add("buy milk");
    const content = readFile(tmpDir);
    assert.ok(content.includes("- [ ] buy milk"), `content: ${content}`);
  });

  test("appends a new open checkbox line", () => {
    add("task one");
    add("task two");
    const todos = list();
    assert.equal(todos.length, 2);
    assert.equal(todos[0].text, "task one");
    assert.equal(todos[1].text, "task two");
    assert.equal(todos[0].done, false);
  });

  test("preserves non-todo lines already in the file", () => {
    // Pre-populate with headings and blank lines
    writeFile(tmpDir, "# My Todos\n\nSome notes here\n\n- [ ] existing task\n");
    add("new task");
    const content = readFile(tmpDir);
    // Non-todo content must survive
    assert.ok(content.includes("# My Todos"), `Heading missing. content:\n${content}`);
    assert.ok(content.includes("Some notes here"), `Prose missing. content:\n${content}`);
    assert.ok(content.includes("- [ ] existing task"), `Existing task missing. content:\n${content}`);
    assert.ok(content.includes("- [ ] new task"), `New task missing. content:\n${content}`);
    // Both todos must be parseable
    const todos = list();
    assert.equal(todos.length, 2);
  });

  test("produces a clean markdown line (- [ ] text)", () => {
    add("check formatting");
    const content = readFile(tmpDir);
    assert.ok(content.includes("- [ ] check formatting"));
  });
});

// ──── setDone ─────────────────────────────────────────────────────────────────

describe("setDone", () => {
  beforeEach(() => {
    savedCwd = process.cwd();
    tmpDir = freshTmp();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("marks an item done (true) by 1-based index", () => {
    add("task one");
    add("task two");
    setDone(1, true);
    const todos = list();
    assert.equal(todos[0].done, true);
    assert.equal(todos[1].done, false);
  });

  test("marks an item open (false) by 1-based index", () => {
    add("task one");
    setDone(1, true);
    setDone(1, false);
    const todos = list();
    assert.equal(todos[0].done, false);
  });

  test("toggles only the correct item when multiple exist", () => {
    add("task one");
    add("task two");
    add("task three");
    setDone(2, true);
    const todos = list();
    assert.equal(todos[0].done, false);
    assert.equal(todos[1].done, true);
    assert.equal(todos[2].done, false);
  });

  test("rewrites file cleanly (- [x] / - [ ] format)", () => {
    add("buy milk");
    setDone(1, true);
    const content = readFile(tmpDir);
    assert.ok(content.includes("- [x] buy milk"), `content: ${content}`);
    assert.ok(!content.includes("- [ ] buy milk"), `open marker still present: ${content}`);
  });

  test("preserves non-todo lines when toggling", () => {
    writeFile(tmpDir, "# Header\n\n- [ ] task one\n- [ ] task two\n");
    setDone(1, true);
    const content = readFile(tmpDir);
    assert.ok(content.includes("# Header"), `Header missing. content:\n${content}`);
    assert.ok(content.includes("- [x] task one"), `Done task missing. content:\n${content}`);
    assert.ok(content.includes("- [ ] task two"), `Other task wrong. content:\n${content}`);
  });

  test("out-of-range index THROWS an Error (does not exit process)", () => {
    add("only task");
    // setDone(2) should throw — NOT call process.exit
    assert.throws(
      () => setDone(2, true),
      (err: unknown) => {
        assert.ok(err instanceof Error, "should throw an Error instance");
        assert.ok(
          err.message.includes("2"),
          `Error message should mention index. Got: ${err.message}`
        );
        return true;
      }
    );
  });

  test("out-of-range on empty file THROWS an Error", () => {
    assert.throws(() => setDone(1, true), Error);
  });
});

// ──── list ────────────────────────────────────────────────────────────────────

describe("list", () => {
  beforeEach(() => {
    savedCwd = process.cwd();
    tmpDir = freshTmp();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("list() returns all todos", () => {
    add("task one");
    add("task two");
    setDone(1, true);
    const all = list();
    assert.equal(all.length, 2);
  });

  test('list("incomplete") returns only open items', () => {
    add("task one");
    add("task two");
    setDone(1, true);
    const incomplete = list("incomplete");
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0].text, "task two");
    assert.equal(incomplete[0].done, false);
  });

  test('list("completed") returns only done items', () => {
    add("task one");
    add("task two");
    setDone(1, true);
    const completed = list("completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0].text, "task one");
    assert.equal(completed[0].done, true);
  });

  test("returns empty array when no file exists", () => {
    assert.deepEqual(list(), []);
    assert.deepEqual(list("incomplete"), []);
    assert.deepEqual(list("completed"), []);
  });

  test("filters correctly with all done / all open", () => {
    add("a");
    add("b");
    setDone(1, true);
    setDone(2, true);
    assert.equal(list("incomplete").length, 0);
    assert.equal(list("completed").length, 2);
  });
});
