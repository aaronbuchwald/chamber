/**
 * vault.test.ts — unit tests for the Vault class.
 *
 * Each test group creates a fresh temp directory so tests are fully isolated.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Vault, VaultError } from "../src/vault.js";

// Helper: create a unique temp dir per test group.
function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vault-test-"));
}

// Helper: remove a dir tree after tests.
function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Round-trips ─────────────────────────────────────────────────────────────

describe("write / read round-trip", () => {
  let root: string;
  let vault: Vault;
  before(() => { root = makeTempRoot(); vault = new Vault(root); });
  after(() => rmrf(root));

  test("writes and reads back UTF-8 content verbatim", () => {
    const content = "# Hello\n\nUnicode: 日本語 🎉\n";
    vault.write("hello.md", content);
    assert.equal(vault.read("hello.md"), content);
  });

  test("overwrites existing file", () => {
    vault.write("overwrite.md", "first");
    vault.write("overwrite.md", "second");
    assert.equal(vault.read("overwrite.md"), "second");
  });

  test("handles nested path", () => {
    vault.write("ideas/note.md", "nested content");
    assert.equal(vault.read("ideas/note.md"), "nested content");
  });
});

// ─── append ──────────────────────────────────────────────────────────────────

describe("append", () => {
  let root: string;
  let vault: Vault;
  before(() => { root = makeTempRoot(); vault = new Vault(root); });
  after(() => rmrf(root));

  test("creates file if missing", () => {
    vault.append("new.md", "line1\n");
    assert.equal(vault.read("new.md"), "line1\n");
  });

  test("appends to existing file", () => {
    vault.write("existing.md", "first\n");
    vault.append("existing.md", "second\n");
    assert.equal(vault.read("existing.md"), "first\nsecond\n");
  });

  test("creates nested dirs as needed", () => {
    vault.append("sub/dir/note.md", "deep content");
    assert.equal(vault.read("sub/dir/note.md"), "deep content");
  });
});

// ─── list ─────────────────────────────────────────────────────────────────────

describe("list", () => {
  let root: string;
  let vault: Vault;
  before(() => {
    root = makeTempRoot();
    vault = new Vault(root);
    vault.write("b.md", "b");
    vault.write("a.md", "a");
    vault.write("ideas/x.md", "x");
    vault.write("ideas/alpha.md", "alpha");
    // Also write a non-.md file directly to ensure it's excluded
    fs.writeFileSync(path.join(root, "ignored.txt"), "not md");
  });
  after(() => rmrf(root));

  test("returns sorted relative paths", () => {
    const files = vault.list();
    // Should be sorted
    const sorted = [...files].sort();
    assert.deepEqual(files, sorted);
  });

  test("includes nested files", () => {
    const files = vault.list();
    assert.ok(files.includes("ideas/x.md"), `expected ideas/x.md in ${files}`);
    assert.ok(files.includes("ideas/alpha.md"), `expected ideas/alpha.md in ${files}`);
  });

  test("excludes non-.md files", () => {
    const files = vault.list();
    assert.ok(!files.some(f => f.endsWith(".txt")), "should not include .txt files");
  });

  test("returns all 4 expected files", () => {
    const files = vault.list();
    assert.equal(files.length, 4);
  });
});

// ─── remove ───────────────────────────────────────────────────────────────────

describe("remove", () => {
  let root: string;
  let vault: Vault;
  before(() => { root = makeTempRoot(); vault = new Vault(root); });
  after(() => rmrf(root));

  test("deletes an existing file", () => {
    vault.write("todelete.md", "bye");
    vault.remove("todelete.md");
    assert.throws(() => vault.read("todelete.md"), /File not found/);
  });

  test("throws VaultError (FileNotFound) for missing file", () => {
    assert.throws(
      () => vault.remove("nonexistent.md"),
      (err: unknown) => {
        assert.ok(err instanceof VaultError);
        assert.match((err as VaultError).message, /File not found/);
        return true;
      }
    );
  });
});

// ─── Safety rejections ────────────────────────────────────────────────────────

describe("safety: non-.md extensions rejected for write/append", () => {
  let root: string;
  let vault: Vault;
  before(() => { root = makeTempRoot(); vault = new Vault(root); });
  after(() => rmrf(root));

  test("rejects .js extension on write", () => {
    assert.throws(() => vault.write("bad.js", "x"), VaultError);
  });

  test("rejects .sh extension on write", () => {
    assert.throws(() => vault.write("bad.sh", "x"), VaultError);
  });

  test("rejects no extension on write", () => {
    assert.throws(() => vault.write("noext", "x"), VaultError);
  });

  test("rejects .js extension on append", () => {
    assert.throws(() => vault.append("bad.js", "x"), VaultError);
  });

  test("rejects .sh extension on append", () => {
    assert.throws(() => vault.append("bad.sh", "x"), VaultError);
  });

  test("rejects no extension on append", () => {
    assert.throws(() => vault.append("noext", "x"), VaultError);
  });
});

describe("safety: path validations", () => {
  let root: string;
  let vault: Vault;
  before(() => { root = makeTempRoot(); vault = new Vault(root); });
  after(() => rmrf(root));

  test("rejects absolute path on write", () => {
    assert.throws(
      () => vault.write("/etc/passwd.md", "x"),
      (err: unknown) => {
        assert.ok(err instanceof VaultError);
        assert.match((err as VaultError).message, /Absolute paths/);
        return true;
      }
    );
  });

  test("rejects absolute path on read", () => {
    assert.throws(() => vault.read("/etc/passwd"), VaultError);
  });

  test("rejects leading ~ on write", () => {
    assert.throws(
      () => vault.write("~/notes.md", "x"),
      (err: unknown) => {
        assert.ok(err instanceof VaultError);
        assert.match((err as VaultError).message, /Absolute paths/);
        return true;
      }
    );
  });

  test("rejects leading ~ on read", () => {
    assert.throws(() => vault.read("~/notes.md"), VaultError);
  });

  test("rejects '..' traversal at top level", () => {
    assert.throws(
      () => vault.write("../escape.md", "x"),
      (err: unknown) => {
        assert.ok(err instanceof VaultError);
        assert.match((err as VaultError).message, /traversal/i);
        return true;
      }
    );
  });

  test("rejects '..' traversal in subdir path", () => {
    assert.throws(
      () => vault.write("subdir/../../x.md", "x"),
      (err: unknown) => {
        assert.ok(err instanceof VaultError);
        assert.match((err as VaultError).message, /traversal/i);
        return true;
      }
    );
  });

  test("rejects NUL character in path", () => {
    assert.throws(
      () => vault.write("note\x00.md", "x"),
      (err: unknown) => {
        assert.ok(err instanceof VaultError);
        assert.match((err as VaultError).message, /control char/i);
        return true;
      }
    );
  });

  test("rejects other control characters in path", () => {
    assert.throws(
      () => vault.write("note\x1f.md", "x"),
      (err: unknown) => {
        assert.ok(err instanceof VaultError);
        assert.match((err as VaultError).message, /control char/i);
        return true;
      }
    );
  });
});

// ─── read of missing file ─────────────────────────────────────────────────────

describe("read of missing file", () => {
  let root: string;
  let vault: Vault;
  before(() => { root = makeTempRoot(); vault = new Vault(root); });
  after(() => rmrf(root));

  test("throws VaultError for missing file", () => {
    assert.throws(
      () => vault.read("missing.md"),
      (err: unknown) => {
        assert.ok(err instanceof VaultError);
        assert.match((err as VaultError).message, /File not found/);
        return true;
      }
    );
  });
});

// ─── No caching (external edits reflected) ────────────────────────────────────

describe("no caching: external edits visible", () => {
  let root: string;
  let vault: Vault;
  before(() => { root = makeTempRoot(); vault = new Vault(root); });
  after(() => rmrf(root));

  test("reflects external appendFileSync without caching", () => {
    vault.write("external.md", "original\n");
    const fullPath = path.join(root, "external.md");
    fs.appendFileSync(fullPath, "appended\n", "utf-8");
    const content = vault.read("external.md");
    assert.equal(content, "original\nappended\n");
  });
});
