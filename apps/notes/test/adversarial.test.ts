/**
 * adversarial.test.ts — adversarial / sandbox-escape regression tests.
 *
 * These tests were written by an adversarial reviewer to expose and lock in
 * sandbox-escape prevention. Each test either:
 *   (A) asserts that a genuine attack is blocked with a VaultError, or
 *   (B) documents by-design behaviour for an ambiguous case.
 *
 * Never weaken these assertions — a failure here means a sandbox regression.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Vault, VaultError } from "../src/vault.js";

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vault-adv-"));
}
function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Symlink escape: read ─────────────────────────────────────────────────────

describe("symlink escape: read", () => {
  let root: string;
  let vault: Vault;

  before(() => {
    root = makeTempRoot();
    vault = new Vault(root);
  });
  after(() => rmrf(root));

  test("blocks read through a .md symlink pointing to an outside file", () => {
    const target = path.join(os.tmpdir(), "vault-adv-outside-read.md");
    fs.writeFileSync(target, "OUTSIDE CONTENT");
    fs.symlinkSync(target, path.join(root, "escape.md"));
    try {
      assert.throws(
        () => vault.read("escape.md"),
        (err: unknown) => {
          assert.ok(err instanceof VaultError, `expected VaultError, got ${err}`);
          assert.match((err as VaultError).message, /[Ss]ymlink/);
          return true;
        }
      );
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  test("blocks read through a directory symlink pointing outside the vault", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-adv-outsidedir-"));
    fs.writeFileSync(path.join(outsideDir, "secret.md"), "OUTSIDE DIR SECRET");
    fs.symlinkSync(outsideDir, path.join(root, "linkdir"));
    try {
      assert.throws(
        () => vault.read("linkdir/secret.md"),
        (err: unknown) => {
          assert.ok(err instanceof VaultError, `expected VaultError, got ${err}`);
          assert.match((err as VaultError).message, /[Ss]ymlink/);
          return true;
        }
      );
    } finally {
      rmrf(outsideDir);
    }
  });

  test("blocks read through a symlink that uses a relative target escaping root", () => {
    // e.g. symlink at vault/rel.md -> ../../etc/hostname (relative symlink)
    const symlinkPath = path.join(root, "rel.md");
    fs.symlinkSync("../../etc/hostname", symlinkPath);
    assert.throws(
      () => vault.read("rel.md"),
      (err: unknown) => {
        assert.ok(err instanceof VaultError);
        assert.match((err as VaultError).message, /[Ss]ymlink/);
        return true;
      }
    );
  });
});

// ─── Symlink escape: write ────────────────────────────────────────────────────

describe("symlink escape: write", () => {
  let root: string;
  let vault: Vault;

  before(() => {
    root = makeTempRoot();
    vault = new Vault(root);
  });
  after(() => rmrf(root));

  test("blocks write through a .md symlink that would overwrite an outside file", () => {
    const target = path.join(os.tmpdir(), "vault-adv-outside-write.md");
    fs.writeFileSync(target, "ORIGINAL");
    fs.symlinkSync(target, path.join(root, "escape.md"));
    try {
      assert.throws(
        () => vault.write("escape.md", "INJECTED"),
        (err: unknown) => {
          assert.ok(err instanceof VaultError);
          assert.match((err as VaultError).message, /[Ss]ymlink/);
          return true;
        }
      );
      // Confirm the outside file was not modified
      assert.equal(fs.readFileSync(target, "utf-8"), "ORIGINAL");
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  test("blocks write through a directory symlink pointing outside", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-adv-writedir-"));
    fs.symlinkSync(outsideDir, path.join(root, "escdir"));
    try {
      assert.throws(
        () => vault.write("escdir/injected.md", "INJECTED"),
        (err: unknown) => {
          assert.ok(err instanceof VaultError);
          assert.match((err as VaultError).message, /[Ss]ymlink/);
          return true;
        }
      );
      // Confirm nothing was written to outside dir
      assert.equal(fs.readdirSync(outsideDir).length, 0);
    } finally {
      rmrf(outsideDir);
    }
  });
});

// ─── Symlink escape: append ───────────────────────────────────────────────────

describe("symlink escape: append", () => {
  let root: string;
  let vault: Vault;

  before(() => {
    root = makeTempRoot();
    vault = new Vault(root);
  });
  after(() => rmrf(root));

  test("blocks append through a .md symlink pointing to an outside file", () => {
    const target = path.join(os.tmpdir(), "vault-adv-outside-append.md");
    fs.writeFileSync(target, "ORIGINAL\n");
    fs.symlinkSync(target, path.join(root, "escape.md"));
    try {
      assert.throws(
        () => vault.append("escape.md", "APPENDED\n"),
        (err: unknown) => {
          assert.ok(err instanceof VaultError);
          assert.match((err as VaultError).message, /[Ss]ymlink/);
          return true;
        }
      );
      assert.equal(fs.readFileSync(target, "utf-8"), "ORIGINAL\n");
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  test("blocks append through a directory symlink pointing outside", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-adv-appenddir-"));
    fs.symlinkSync(outsideDir, path.join(root, "escapedir"));
    try {
      assert.throws(
        () => vault.append("escapedir/injected.md", "APPENDED"),
        (err: unknown) => {
          assert.ok(err instanceof VaultError);
          assert.match((err as VaultError).message, /[Ss]ymlink/);
          return true;
        }
      );
      assert.equal(fs.readdirSync(outsideDir).length, 0);
    } finally {
      rmrf(outsideDir);
    }
  });
});

// ─── Symlink escape: remove ───────────────────────────────────────────────────

describe("symlink escape: remove", () => {
  let root: string;
  let vault: Vault;

  before(() => {
    root = makeTempRoot();
    vault = new Vault(root);
  });
  after(() => rmrf(root));

  test("blocks remove of a .md symlink (prevents unlink of the link itself)", () => {
    const target = path.join(os.tmpdir(), "vault-adv-outside-remove.md");
    fs.writeFileSync(target, "SHOULD STAY");
    fs.symlinkSync(target, path.join(root, "escape.md"));
    try {
      assert.throws(
        () => vault.remove("escape.md"),
        (err: unknown) => {
          assert.ok(err instanceof VaultError);
          assert.match((err as VaultError).message, /[Ss]ymlink/);
          return true;
        }
      );
      // Target must still exist
      assert.ok(fs.existsSync(target));
    } finally {
      // Clean up the symlink manually (can't go through vault)
      const link = path.join(root, "escape.md");
      if (fs.existsSync(link) || fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
      fs.rmSync(target, { force: true });
    }
  });
});

// ─── Symlink escape: list ─────────────────────────────────────────────────────

describe("symlink escape: list", () => {
  let root: string;
  let vault: Vault;

  before(() => {
    root = makeTempRoot();
    vault = new Vault(root);
    // Write a real .md file to ensure list() still works normally
    vault.write("real.md", "real");
  });
  after(() => rmrf(root));

  test("list() does not include .md symlinks in results", () => {
    const target = path.join(os.tmpdir(), "vault-adv-list-target.md");
    fs.writeFileSync(target, "outside");
    fs.symlinkSync(target, path.join(root, "symlisted.md"));
    try {
      const files = vault.list();
      assert.ok(
        !files.includes("symlisted.md"),
        `symlink should be excluded from list, got: ${files}`
      );
      // The real file should still appear
      assert.ok(files.includes("real.md"));
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  test("list() does not descend into a symlinked directory", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-adv-listdir-"));
    fs.writeFileSync(path.join(outsideDir, "secret.md"), "outside secret");
    fs.symlinkSync(outsideDir, path.join(root, "linkdir"));
    try {
      const files = vault.list();
      assert.ok(
        !files.some((f) => f.startsWith("linkdir")),
        `list() should not descend into symlinked dir, got: ${files}`
      );
    } finally {
      rmrf(outsideDir);
    }
  });
});

// ─── Path traversal variants ──────────────────────────────────────────────────

describe("path traversal: backslash and mixed variants", () => {
  let root: string;
  let vault: Vault;

  before(() => {
    root = makeTempRoot();
    vault = new Vault(root);
  });
  after(() => rmrf(root));

  test("blocks backslash-separated traversal on write  (..\\..\\x.md)", () => {
    assert.throws(
      () => vault.write("..\\..\\x.md", "x"),
      (err: unknown) => {
        assert.ok(err instanceof VaultError);
        assert.match((err as VaultError).message, /traversal/i);
        return true;
      }
    );
  });

  test("blocks mixed a/../../b.md traversal on write", () => {
    assert.throws(
      () => vault.write("a/../../b.md", "x"),
      (err: unknown) => {
        assert.ok(err instanceof VaultError);
        assert.match((err as VaultError).message, /traversal/i);
        return true;
      }
    );
  });

  test("blocks sub/../../../escape.md traversal on read", () => {
    assert.throws(
      () => vault.read("sub/../../../escape.md"),
      (err: unknown) => {
        assert.ok(err instanceof VaultError);
        assert.match((err as VaultError).message, /traversal/i);
        return true;
      }
    );
  });

  test("blocks backslash traversal on read", () => {
    assert.throws(
      () => vault.read("..\\..\\x.md"),
      (err: unknown) => {
        assert.ok(err instanceof VaultError);
        assert.match((err as VaultError).message, /traversal/i);
        return true;
      }
    );
  });
});

// ─── Extension bypass attempts ────────────────────────────────────────────────

describe("extension bypasses", () => {
  let root: string;
  let vault: Vault;

  before(() => {
    root = makeTempRoot();
    vault = new Vault(root);
  });
  after(() => rmrf(root));

  // ── By-design: uppercase is accepted (assertMarkdown lowercases before check)
  test("BY-DESIGN: write with .MD extension is accepted (case-insensitive)", () => {
    assert.doesNotThrow(() => vault.write("note.MD", "uppercase ext"));
  });

  test("BY-DESIGN: write with .MARKDOWN extension is accepted (case-insensitive)", () => {
    assert.doesNotThrow(() => vault.write("note.MARKDOWN", "uppercase ext"));
  });

  // ── Attacks that must be blocked
  test("blocks write with trailing dot  note.md.", () => {
    assert.throws(() => vault.write("note.md.", "x"), VaultError);
  });

  test("blocks write with double extension  note.md.js  (ext is .js)", () => {
    assert.throws(() => vault.write("note.md.js", "x"), VaultError);
  });

  test("blocks write with trailing space  'note.md '  (ext contains space)", () => {
    assert.throws(() => vault.write("note.md ", "x"), VaultError);
  });

  test("blocks write of non-.md file inside a .md-named directory  foo.md/evil.js", () => {
    // foo.md is a directory here; evil.js extension must still be rejected
    assert.throws(() => vault.write("foo.md/evil.js", "x"), VaultError);
  });

  test("BY-DESIGN: note.js.md is accepted — final extension is .md", () => {
    // path.extname('note.js.md') === '.md'
    assert.doesNotThrow(() => vault.write("note.js.md", "content"));
  });
});

// ─── Empty and degenerate paths ───────────────────────────────────────────────

describe("empty and degenerate paths", () => {
  let root: string;
  let vault: Vault;

  before(() => {
    root = makeTempRoot();
    vault = new Vault(root);
  });
  after(() => rmrf(root));

  test("write with empty path throws VaultError (no extension)", () => {
    assert.throws(() => vault.write("", "x"), VaultError);
  });

  test("write with '.' path throws VaultError (no extension)", () => {
    assert.throws(() => vault.write(".", "x"), VaultError);
  });

  test("read with empty path throws (reaches root dir, EISDIR or VaultError)", () => {
    // The root resolves to the vault root itself — reading a dir is an error
    assert.throws(() => vault.read(""));
  });

  test("remove with empty path throws (reaches root dir, EISDIR or VaultError)", () => {
    assert.throws(() => vault.remove(""));
  });
});

// ─── Leading ./ and dot segments ─────────────────────────────────────────────

describe("leading dot-slash and dot segments", () => {
  let root: string;
  let vault: Vault;

  before(() => {
    root = makeTempRoot();
    vault = new Vault(root);
  });
  after(() => rmrf(root));

  test("BY-DESIGN: leading ./ is accepted and writes inside the vault", () => {
    vault.write("./note.md", "dot-slash content");
    const p = path.join(root, "note.md");
    assert.ok(fs.existsSync(p));
    assert.equal(fs.readFileSync(p, "utf-8"), "dot-slash content");
  });

  test("BY-DESIGN: ./sub/./note.md is accepted and writes to sub/note.md", () => {
    vault.write("./sub/./note.md", "dot segment");
    const p = path.join(root, "sub", "note.md");
    assert.ok(fs.existsSync(p));
  });
});

// ─── Double slashes and long paths ───────────────────────────────────────────

describe("double slashes and very long paths", () => {
  let root: string;
  let vault: Vault;

  before(() => {
    root = makeTempRoot();
    vault = new Vault(root);
  });
  after(() => rmrf(root));

  test("BY-DESIGN: sub//note.md is accepted (path.resolve collapses double slash)", () => {
    vault.write("sub//note.md", "double slash content");
    assert.ok(fs.existsSync(path.join(root, "sub", "note.md")));
  });

  test("BY-DESIGN: very deeply nested path is accepted within the vault", () => {
    const longPath = "a/".repeat(10) + "note.md";
    vault.write(longPath, "deep content");
    assert.equal(vault.read(longPath), "deep content");
  });
});

// ─── Unicode and special characters in filenames ─────────────────────────────

describe("unicode and special characters in filenames", () => {
  let root: string;
  let vault: Vault;

  before(() => {
    root = makeTempRoot();
    vault = new Vault(root);
  });
  after(() => rmrf(root));

  test("BY-DESIGN: unicode filename is accepted (üñîcödé.md)", () => {
    vault.write("üñîcödé.md", "unicode content");
    assert.equal(vault.read("üñîcödé.md"), "unicode content");
  });

  test("NUL byte in path is rejected", () => {
    assert.throws(
      () => vault.write("note\x00.md", "x"),
      (err: unknown) => {
        assert.ok(err instanceof VaultError);
        assert.match((err as VaultError).message, /control char/i);
        return true;
      }
    );
  });

  test("control character (0x1b) in path is rejected", () => {
    assert.throws(
      () => vault.write("note\x1b.md", "x"),
      (err: unknown) => {
        assert.ok(err instanceof VaultError);
        assert.match((err as VaultError).message, /control char/i);
        return true;
      }
    );
  });
});

// ─── Windows-style paths ─────────────────────────────────────────────────────

describe("Windows-style absolute paths", () => {
  let root: string;
  let vault: Vault;

  before(() => {
    root = makeTempRoot();
    vault = new Vault(root);
  });
  after(() => rmrf(root));

  test("BY-DESIGN: C:\\windows.md is treated as a relative path on Linux (no escape)", () => {
    // On Linux path.isAbsolute('C:\\windows.md') === false;
    // path.resolve(root, 'C:\\windows.md') stays inside the vault root.
    // The file lands at <root>/C:\windows.md — weird but safe.
    vault.write("C:\\windows.md", "windows path content");
    const files = vault.list();
    // The file should be inside the vault root
    assert.ok(
      files.some((f) => f.includes("windows.md")),
      `expected a windows.md entry in ${files}`
    );
    // Confirm it resolves inside the vault
    const allFiles = fs.readdirSync(root, { recursive: true } as Parameters<typeof fs.readdirSync>[1]) as string[];
    for (const f of allFiles) {
      const full = path.join(root, f);
      assert.ok(
        full.startsWith(root + path.sep) || full === root,
        `file escaped vault root: ${full}`
      );
    }
  });
});
