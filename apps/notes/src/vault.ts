/**
 * vault.ts — core sandboxed markdown store
 *
 * Safety rules enforced here (host-style, never delegated to callers):
 *   1. Only .md / .markdown extensions allowed for write/append.
 *   2. Reject absolute paths, leading ~, NUL or control chars, .. segments.
 *   3. Resolve final path and verify it stays within vault root (anti-traversal).
 *   4. Content stored verbatim as UTF-8; never parsed or executed.
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

    return resolved;
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

  /** List all .md / .markdown files in the vault, sorted. */
  list(): string[] {
    const results: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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
