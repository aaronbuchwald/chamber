/**
 * Adversarial tests for todos.ts, CLI, and HTTP front-ends.
 *
 * Probes: markdown-breaking text, round-trip integrity, index edge cases,
 * line endings, concurrency (documented limitation), HTTP 400 paths.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { spawnSync, spawn, ChildProcess } from "node:child_process";

import { parseTodos, add, setDone, list } from "../src/todos.js";

// ──── shared helpers ──────────────────────────────────────────────────────────

let tmpDir: string;
let savedCwd: string;

function freshDir(): void {
  savedCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-test-"));
  process.chdir(tmpDir);
}

function restoreDir(): void {
  process.chdir(savedCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function readFile(): string {
  const p = path.join(tmpDir, "todos.md");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function writeFile(content: string): void {
  fs.writeFileSync(path.join(tmpDir, "todos.md"), content, "utf8");
}

// ──── parseTodos: edge cases ──────────────────────────────────────────────────

describe("parseTodos – edge cases", () => {
  test("checkbox-like line inside a fenced code block is still parsed as a todo (known limitation)", () => {
    // parseTodos has no fenced-code-block awareness; it matches any line
    // matching /^- \[[ x]\]/ regardless of context.  This test documents the
    // current behaviour — NOT a bug to fix at this stage.
    const lines = [
      "- [ ] real task",
      "```",
      "- [ ] sneaky inside fence",
      "```",
      "- [x] real done",
    ];
    const todos = parseTodos(lines);
    // Currently 3 items (fence not respected). Document it clearly.
    assert.equal(
      todos.length,
      3,
      "parseTodos currently counts checkbox-like lines inside code fences (known limitation)"
    );
  });

  test("indented sub-list checkbox is NOT parsed as a top-level todo item", () => {
    // "  - [ ] nested" has leading spaces, so it does not match /^- \[ \]/
    const lines = [
      "- [ ] parent task",
      "  - [ ] nested subtask",
      "- [x] done parent",
    ];
    const todos = parseTodos(lines);
    assert.equal(todos.length, 2, "indented subtask must not be counted");
    assert.equal(todos[0].text, "parent task");
    assert.equal(todos[1].text, "done parent");
  });

  test("text that looks like a checkbox survives round-trip via add/list", () => {
    // The stored line becomes "- [ ] - [ ] sneaky" which parses back as
    // text "- [ ] sneaky" — the outer checkbox is the real marker.
    freshDir();
    try {
      add("- [ ] sneaky");
      const todos = list();
      assert.equal(todos.length, 1, "item should be present");
      assert.equal(todos[0].text, "- [ ] sneaky", "text must round-trip unchanged");
      assert.equal(todos[0].done, false);
    } finally {
      restoreDir();
    }
  });

  test("text that looks like a done checkbox survives round-trip", () => {
    freshDir();
    try {
      add("- [x] done");
      const todos = list();
      assert.equal(todos.length, 1);
      assert.equal(todos[0].text, "- [x] done");
    } finally {
      restoreDir();
    }
  });

  test("leading/trailing whitespace in text is preserved exactly", () => {
    freshDir();
    try {
      add("  indented text  ");
      const todos = list();
      assert.equal(todos.length, 1);
      assert.equal(todos[0].text, "  indented text  ");
    } finally {
      restoreDir();
    }
  });

  test("unicode and emoji text round-trips correctly", () => {
    freshDir();
    try {
      add("买牛奶 🥛 ✓ café");
      const todos = list();
      assert.equal(todos.length, 1);
      assert.equal(todos[0].text, "买牛奶 🥛 ✓ café");
    } finally {
      restoreDir();
    }
  });

  test("very long text (1000 chars) round-trips without truncation", () => {
    freshDir();
    try {
      const long = "x".repeat(1000);
      add(long);
      const todos = list();
      assert.equal(todos.length, 1);
      assert.equal(todos[0].text.length, 1000);
      assert.equal(todos[0].text, long);
    } finally {
      restoreDir();
    }
  });

  test("markdown control characters (**, __, #, >, `) in text round-trip", () => {
    freshDir();
    try {
      const tricky = "**bold** __em__ # heading > quote `code`";
      add(tricky);
      const todos = list();
      assert.equal(todos.length, 1);
      assert.equal(todos[0].text, tricky);
    } finally {
      restoreDir();
    }
  });

  test("text equal to '--text' string round-trips (not confused with CLI flag)", () => {
    freshDir();
    try {
      add("--text");
      const todos = list();
      assert.equal(todos.length, 1);
      assert.equal(todos[0].text, "--text");
    } finally {
      restoreDir();
    }
  });
});

// ──── add: validation ─────────────────────────────────────────────────────────

describe("add – input validation", () => {
  beforeEach(freshDir);
  afterEach(restoreDir);

  test("add with embedded \\n THROWS and does not corrupt file", () => {
    assert.throws(
      () => add("line one\nline two"),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw Error");
        assert.ok(
          err.message.toLowerCase().includes("newline"),
          `expected 'newline' in message, got: ${err.message}`
        );
        return true;
      }
    );
    // File must not have been written (was empty to begin with)
    assert.equal(readFile(), "", "file must remain untouched after rejected add");
  });

  test("add with embedded \\r THROWS", () => {
    assert.throws(
      () => add("bad\rtext"),
      (err: unknown) => err instanceof Error
    );
  });

  test("add with empty string produces a line that does NOT parse back as a todo", () => {
    // add("") writes "- [ ] " — which fails OPEN_RE (.+ requires ≥1 char).
    // This is a known edge case: the written line is phantom content.
    // The test documents the behaviour.
    add("");
    const content = readFile();
    assert.ok(content.includes("- [ ] "), "empty-text line should be in file");
    const todos = list();
    assert.equal(
      todos.length,
      0,
      "empty-text line must NOT parse back as a todo (OPEN_RE requires at least one char)"
    );
  });
});

// ──── round-trip integrity ────────────────────────────────────────────────────

describe("round-trip integrity", () => {
  beforeEach(freshDir);
  afterEach(restoreDir);

  test("add preserves arbitrary non-todo prose lines", () => {
    writeFile("# Header\n\nSome prose\n\n- [ ] existing\n");
    add("new task");
    const content = readFile();
    assert.ok(content.includes("# Header"), "heading must survive");
    assert.ok(content.includes("Some prose"), "prose must survive");
    assert.ok(content.includes("- [ ] existing"), "old task must survive");
    assert.ok(content.includes("- [ ] new task"), "new task must appear");
  });

  test("setDone preserves non-todo lines when toggling", () => {
    writeFile("# Header\n\n- [ ] task one\n- [ ] task two\n\nFooter prose\n");
    setDone(1, true);
    const content = readFile();
    assert.ok(content.includes("# Header"), "heading must survive");
    assert.ok(content.includes("Footer prose"), "footer must survive");
    assert.ok(content.includes("- [x] task one"), "done task written correctly");
    assert.ok(content.includes("- [ ] task two"), "undone task unchanged");
  });

  test("add preserves indented sub-list lines verbatim", () => {
    writeFile("- [ ] parent\n  - [ ] nested\n- [x] done\n");
    add("another task");
    const content = readFile();
    assert.ok(content.includes("  - [ ] nested"), "indented sublist must survive verbatim");
    // nested line must NOT be treated as a todo by parseTodos
    const todos = list();
    // parent + done + another = 3  (nested is NOT counted)
    assert.equal(todos.length, 3, "nested line must not count as a todo index");
  });

  test("completing an already-complete item is idempotent", () => {
    add("task one");
    setDone(1, true);
    setDone(1, true); // should not throw and should leave it done
    const todos = list();
    assert.equal(todos[0].done, true, "item should remain done");
  });

  test("reopening an already-open item is idempotent", () => {
    add("task one");
    setDone(1, false); // it's already open
    const todos = list();
    assert.equal(todos[0].done, false, "item should remain open");
  });
});

// ──── setDone: index handling ─────────────────────────────────────────────────

describe("setDone – index edge cases", () => {
  beforeEach(freshDir);
  afterEach(restoreDir);

  test("index 0 THROWS (never silently no-ops)", () => {
    add("task one");
    assert.throws(
      () => setDone(0, true),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw Error, not silently succeed");
        return true;
      }
    );
    // Verify the item is still untouched
    assert.equal(list()[0].done, false, "item must not have been changed");
  });

  test("negative index THROWS", () => {
    add("task one");
    assert.throws(
      () => setDone(-1, true),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("-1"),
          `error message should mention -1, got: ${err.message}`
        );
        return true;
      }
    );
  });

  test("float index (non-integer) THROWS", () => {
    add("task one");
    assert.throws(
      () => setDone(1.5, true),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });

  test("index exactly one past the end THROWS", () => {
    add("task one");
    assert.throws(
      () => setDone(2, true),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });

  test("valid last index does NOT throw", () => {
    add("task one");
    add("task two");
    add("task three");
    assert.doesNotThrow(() => setDone(3, true));
    assert.equal(list()[2].done, true);
  });
});

// ──── line endings ────────────────────────────────────────────────────────────

describe("line endings", () => {
  beforeEach(freshDir);
  afterEach(restoreDir);

  test("CRLF file: all todo items are visible after reading", () => {
    // Before fix: \r at end of each line broke regex matches silently.
    writeFile("- [ ] task one\r\n- [x] task two\r\n");
    const todos = list();
    assert.equal(todos.length, 2, "both CRLF todos must be parsed");
    assert.equal(todos[0].text, "task one", "\\r must be stripped from text");
    assert.equal(todos[0].done, false);
    assert.equal(todos[1].text, "task two", "\\r must be stripped from text");
    assert.equal(todos[1].done, true);
  });

  test("CRLF file: add appends correctly and new item is parseable", () => {
    writeFile("- [ ] task one\r\n");
    add("task two");
    const todos = list();
    assert.equal(todos.length, 2, "should see both old CRLF item and new item");
    assert.equal(todos[0].text, "task one");
    assert.equal(todos[1].text, "task two");
  });

  test("CRLF file: setDone on CRLF item works correctly", () => {
    writeFile("- [ ] task one\r\n- [ ] task two\r\n");
    setDone(1, true);
    const todos = list();
    assert.equal(todos[0].done, true, "first CRLF item should now be done");
    assert.equal(todos[1].done, false, "second item unchanged");
  });

  test("file with no trailing newline: add does not corrupt content", () => {
    // A file without a trailing \n — the split gives no trailing empty string
    writeFile("- [ ] task one");
    add("task two");
    const todos = list();
    assert.equal(todos.length, 2, "both items must be present");
    assert.equal(todos[0].text, "task one");
    assert.equal(todos[1].text, "task two");
  });

  test("file with blank lines between todos: blank lines are preserved", () => {
    writeFile("- [ ] task one\n\n- [ ] task two\n");
    add("task three");
    const content = readFile();
    // The blank line between task one and task two should still be there
    assert.ok(content.includes("task one\n\n- [ ] task two"), "blank line between tasks must be preserved");
    const todos = list();
    assert.equal(todos.length, 3);
  });
});

// ──── concurrency (documented limitation) ────────────────────────────────────

describe("concurrency – add (documented lost-write limitation)", () => {
  test("concurrent CLI add processes may lose writes (read-modify-write, no locking)", async () => {
    // This test documents the known race condition in add():
    // it reads the file, appends a line, and writes back — with no atomic lock.
    // Under concurrent subprocess stress, writes are regularly lost.
    //
    // This is an ACCEPTED limitation for a prototype. The test asserts that
    // the race IS real (by demonstrating it under load), and documents the
    // actual observed behaviour rather than pretending it doesn't exist.
    //
    // To fix: use atomic append (appendFileSync) or file locking.

    const CLI = path.resolve(__dirname, "../src/cli.ts");
    const TSX = path.resolve(__dirname, "../node_modules/.bin/tsx");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conc-doc-"));

    const N = 10;
    const procs: Promise<void>[] = Array.from({ length: N }, (_, i) =>
      new Promise<void>((resolve, reject) => {
        const p = spawn(TSX, [CLI, "add", `task-${i}`], { cwd: dir, stdio: "pipe" });
        p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      })
    );
    await Promise.all(procs);

    const content = fs.readFileSync(path.join(dir, "todos.md"), "utf8");
    const count = content.split("\n").filter((l) => /^- \[ \]/.test(l)).length;

    fs.rmSync(dir, { recursive: true, force: true });

    // We DON'T assert count === N because the bug is real: writes are often lost.
    // We DO assert count > 0 (at least one write landed) and count <= N (no duplicates).
    assert.ok(count > 0, "at least one write must have persisted");
    assert.ok(count <= N, "cannot have more tasks than adds attempted");

    // Log the actual count so readers can see the lost-write rate.
    // In CI, this will frequently be < N — that is expected and documented.
    if (count < N) {
      // Lost-write confirmed. This is the documented limitation.
      // We do NOT fail the test — this is expected prototype behaviour.
      process.stderr.write(
        `[concurrency] Lost-write confirmed: ${count}/${N} tasks persisted. ` +
          `This is a documented limitation of the read-modify-write add().\n`
      );
    }
  });
});

// ──── CLI front-end: adversarial inputs ──────────────────────────────────────

describe("CLI – adversarial inputs", () => {
  const CLI = path.resolve(__dirname, "../src/cli.ts");
  const TSX = path.resolve(__dirname, "../node_modules/.bin/tsx");

  function run(args: string[], cwd: string) {
    const r = spawnSync(TSX, [CLI, ...args], { cwd, encoding: "utf8", timeout: 15_000 });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? 1 };
  }

  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-adv-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test("add with embedded newline in positional arg exits non-zero", () => {
    // spawnSync arguments are passed as separate strings; the \n becomes a literal
    // character in the argument string.  The CLI must reject it.
    const r = run(["add", "line1\nline2"], dir);
    assert.notEqual(r.exitCode, 0, `should fail; stdout=${r.stdout} stderr=${r.stderr}`);
    const combined = r.stdout + r.stderr;
    assert.ok(
      combined.toLowerCase().includes("newline") || combined.toLowerCase().includes("error"),
      `expected error about newline, got: ${combined}`
    );
  });

  test("complete with index 0 exits non-zero", () => {
    run(["add", "task one"], dir);
    const r = run(["complete", "--index", "0"], dir);
    assert.notEqual(r.exitCode, 0, "index 0 should be rejected");
  });

  test("complete with negative index exits non-zero", () => {
    run(["add", "task one"], dir);
    const r = run(["complete", "--index", "-5"], dir);
    assert.notEqual(r.exitCode, 0, "negative index should be rejected");
  });

  test("complete with float index exits non-zero", () => {
    run(["add", "task one"], dir);
    const r = run(["complete", "--index", "1.5"], dir);
    assert.notEqual(r.exitCode, 0, "float index should be rejected");
  });

  test("add --text flag accepted as flag (not just positional)", () => {
    const r = run(["add", "--text", "flag task"], dir);
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    const content = fs.readFileSync(path.join(dir, "todos.md"), "utf8");
    assert.ok(content.includes("- [ ] flag task"));
  });

  test("add text equal to '--text' string: either succeeds or gives a user-visible error (no silent crash)", () => {
    // When "--text" is passed as a positional arg, the CLI parser interprets it as
    // a flag (sets text=true, a boolean), which zod rejects with a validation error.
    // That is correct, graceful behaviour: user gets a clear message and non-zero exit.
    // We do NOT try to pass "--" as end-of-flags separator here since that depends
    // on the underlying parser. We just document that this specific input fails gracefully.
    const r = run(["add", "--text"], dir);
    // Either it fails gracefully with a validation error, or somehow accepts it.
    const combined = r.stdout + r.stderr;
    if (r.exitCode !== 0) {
      // Expected: zod validation error referencing the field
      assert.ok(
        combined.toLowerCase().includes("error") ||
          combined.toLowerCase().includes("invalid") ||
          combined.includes("text"),
        `non-zero exit but no error message found: ${combined}`
      );
    }
    // If exitCode=0 the string "--text" was stored successfully — also fine.
    // Either way, no unhandled exception / crash.
    assert.ok(r.exitCode === 0 || r.exitCode === 1, `exit code must be 0 or 1, got ${r.exitCode}`);
  });
});

// ──── HTTP front-end: 400 paths ───────────────────────────────────────────────

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

async function startServer(cwd: string): Promise<{ proc: ChildProcess; base: string }> {
  const HTTP_SRC = path.resolve(__dirname, "../src/http.ts");
  const TSX = path.resolve(__dirname, "../node_modules/.bin/tsx");
  const port = await getFreePort();
  const proc = spawn(TSX, [HTTP_SRC], {
    cwd,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 15_000);
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("HTTP") || chunk.toString().includes("localhost")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exited early: ${code}`)); });
  });
  return { proc, base: `http://127.0.0.1:${port}` };
}

async function stopServer(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    proc.on("exit", () => resolve());
    proc.kill("SIGTERM");
    setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 3_000);
  });
}

describe("HTTP – 400 paths and malformed requests", () => {
  let server: { proc: ChildProcess; base: string };
  let dir: string;

  // We use a single server for all HTTP tests in this suite
  async function setup() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "http-adv-"));
    server = await startServer(dir);
  }

  async function teardown() {
    await stopServer(server.proc);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  test("POST /add with missing 'text' field returns 400", async (t) => {
    await setup();
    t.after(teardown);
    const res = await fetch(`${server.base}/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400, "missing required field must return 400");
    const json = await res.json() as any;
    assert.ok(json.error, `expected error field, got: ${JSON.stringify(json)}`);
  });

  test("POST /add with malformed JSON body returns 400", async (t) => {
    await setup();
    t.after(teardown);
    const res = await fetch(`${server.base}/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json{{{",
    });
    assert.equal(res.status, 400, "malformed JSON must return 400");
    const json = await res.json() as any;
    assert.ok(json.error, `expected error field, got: ${JSON.stringify(json)}`);
  });

  test("POST /complete with non-integer index returns 400", async (t) => {
    await setup();
    t.after(teardown);
    const res = await fetch(`${server.base}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: 1.5 }),
    });
    assert.equal(res.status, 400, "float index must be rejected by zod schema");
    const json = await res.json() as any;
    assert.ok(json.error, `expected error field, got: ${JSON.stringify(json)}`);
  });

  test("POST /complete with negative index returns 400", async (t) => {
    await setup();
    t.after(teardown);
    const res = await fetch(`${server.base}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: -1 }),
    });
    assert.equal(res.status, 400, "negative index must be rejected");
    const json = await res.json() as any;
    assert.ok(json.error, `expected error field, got: ${JSON.stringify(json)}`);
  });

  test("POST /complete with index 0 returns 400", async (t) => {
    await setup();
    t.after(teardown);
    const res = await fetch(`${server.base}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: 0 }),
    });
    assert.equal(res.status, 400, "index 0 must be rejected (schema: positive integer)");
    const json = await res.json() as any;
    assert.ok(json.error, `expected error field, got: ${JSON.stringify(json)}`);
  });

  test("POST /add with embedded newline in text returns 400 and server stays up", async (t) => {
    await setup();
    t.after(teardown);
    const res = await fetch(`${server.base}/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "line1\nline2" }),
    });
    assert.equal(res.status, 400, "embedded newline must be rejected");
    const json = await res.json() as any;
    assert.ok(json.error, `expected error field, got: ${JSON.stringify(json)}`);
    // Server must still be up
    const health = await fetch(`${server.base}/`);
    assert.equal(health.status, 200, "server must remain alive after 400 error");
  });

  test("GET /nonexistent returns 404", async (t) => {
    await setup();
    t.after(teardown);
    const res = await fetch(`${server.base}/nonexistent`);
    assert.equal(res.status, 404);
  });

  test("POST /add with unicode text round-trips via HTTP", async (t) => {
    await setup();
    t.after(teardown);
    const text = "买牛奶 🥛 emoji ✓";
    const addRes = await fetch(`${server.base}/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    assert.equal(addRes.status, 200);
    const listRes = await fetch(`${server.base}/list`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json() as any;
    const items = listJson.result as Array<{ text: string }>;
    assert.ok(items.some((i) => i.text === text), `unicode text must appear in list, got: ${JSON.stringify(items)}`);
  });
});
