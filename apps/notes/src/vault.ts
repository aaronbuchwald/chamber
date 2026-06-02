/**
 * vault.ts — core sandboxed markdown store
 *
 * Safety rules enforced here (host-style, never delegated to callers):
 *   1. Only .md / .markdown extensions allowed for write/append.
 *   2. Reject absolute paths, leading ~, NUL or control chars, .. segments.
 *   3. Resolve final path and verify it stays within vault root (anti-traversal).
 *   4. Reject any symlink at any component of the resolved path (symlink escape).
 *   5. Content stored verbatim as UTF-8; never parsed or executed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ALLOWED_EXTENSIONS = new Set([".md", ".markdown"]);

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Validate and resolve a caller-supplied relative path inside the vault. */
  private safePath(relativePath: string): string {
    // 1. Reject NUL / control characters
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(relativePath)) {
      throw new VaultError(`Path contains control characters: ${JSON.stringify(relativePath)}`);
    }

    // 2. Reject absolute paths and leading ~ or /
    if (path.isAbsolute(relativePath) || relativePath.startsWith("~")) {
      throw new VaultError(`Absolute paths are not allowed: ${relativePath}`);
    }

    // 3. Reject explicit .. segments (defence-in-depth before resolve)
    const parts = relativePath.split(/[/\\]/);
    if (parts.includes("..")) {
      throw new VaultError(`Path traversal via '..' is not allowed: ${relativePath}`);
    }

    // 4. Resolve and confirm it stays inside the vault root
    const resolved = path.resolve(this.root, relativePath);
    if (!resolved.startsWith(this.root + path.sep) && resolved !== this.root) {
      throw new VaultError(`Path escapes vault root: ${relativePath}`);
    }

    // 5. Reject any symlink at any component of the resolved path.
    //    path.resolve() does NOT follow symlinks, so a symlink inside the vault
    //    that points outside passes the root-containment check above but would
    //    escape the sandbox at the I/O call. We walk each path component from
    //    the vault root downward and reject the first symlink found.
    this.assertNoSymlink(resolved);

    return resolved;
  }

  /**
   * Walk every component of `resolved` that lies under `this.root` and throw
   * a VaultError if any component is a symbolic link.
   *
   * Components that do not yet exist (e.g. a new file being written) are skipped
   * after the first ENOENT — they are safe because nothing is there yet.
   */
  private assertNoSymlink(resolved: string): void {
    const relative = path.relative(this.root, resolved);
    // Empty relative means resolved === root, nothing to check.
    if (!relative) return;

    const segments = relative.split(path.sep);
    let current = this.root;
    for (const segment of segments) {
      current = path.join(current, segment);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(current);
      } catch (err: unknown) {
        // ENOENT: the rest of the path doesn't exist yet — safe.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
        throw err;
      }
      if (stat.isSymbolicLink()) {
        throw new VaultError(`Symlinks are not allowed inside the vault: ${current}`);
      }
    }
  }

  /** Assert that the path has an allowed markdown extension. */
  private assertMarkdown(filePath: string): void {
    const ext = path.extname(filePath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new VaultError(
        `Only .md / .markdown files are allowed; got extension '${ext || "(none)"}' for: ${filePath}`
      );
    }
  }

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * List all .md / .markdown files in the vault, sorted.
   *
   * Symlinked entries (files or directories) are intentionally excluded:
   * including them would present names that the other operations would then
   * refuse to access, which is confusing and potentially misleading.
   */
  list(): string[] {
    const results: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        // Skip symlinks — they are not permitted vault members.
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          results.push(path.relative(this.root, full));
        }
      }
    };
    walk(this.root);
    return results.sort();
  }

  /** Read a file and return its UTF-8 content. */
  read(relativePath: string): string {
    const resolved = this.safePath(relativePath);
    if (!fs.existsSync(resolved)) {
      throw new VaultError(`File not found: ${relativePath}`);
    }
    return fs.readFileSync(resolved, "utf-8");
  }

  /** Create or overwrite a file. Only .md / .markdown allowed. */
  write(relativePath: string, text: string): void {
    this.assertMarkdown(relativePath);
    const resolved = this.safePath(relativePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, text, "utf-8");
  }

  /** Append text to a file (create if missing). Only .md / .markdown allowed. */
  append(relativePath: string, text: string): void {
    this.assertMarkdown(relativePath);
    const resolved = this.safePath(relativePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.appendFileSync(resolved, text, "utf-8");
  }

  /** Delete a file. */
  remove(relativePath: string): void {
    const resolved = this.safePath(relativePath);
    if (!fs.existsSync(resolved)) {
      throw new VaultError(`File not found: ${relativePath}`);
    }
    fs.unlinkSync(resolved);
  }
}
