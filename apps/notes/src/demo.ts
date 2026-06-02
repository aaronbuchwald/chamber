/**
 * demo.ts — Chamber Notes prototype demonstration
 *
 * Covers:
 *   - write, list, read via Vault API
 *   - external (human-simulated) edit bypassing the API → reflected on read/list
 *   - rejection of non-.md path
 *   - rejection of path-traversal attempt
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Vault, VaultError } from "./vault.js";

const DEMO_ROOT = path.resolve("vault-demo");

// ── utilities ─────────────────────────────────────────────────────────────────

function section(title: string): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

function expectError(label: string, fn: () => unknown): void {
  try {
    fn();
    console.log(`  FAIL — expected VaultError for: ${label}`);
    process.exit(1);
  } catch (err) {
    if (err instanceof VaultError) {
      console.log(`  [REJECTED as expected] ${err.message}`);
    } else {
      throw err;
    }
  }
}

// ── clean slate ───────────────────────────────────────────────────────────────

if (fs.existsSync(DEMO_ROOT)) {
  fs.rmSync(DEMO_ROOT, { recursive: true, force: true });
}

const vault = new Vault(DEMO_ROOT);

// ── 1. Write a couple of notes ────────────────────────────────────────────────

section("1. Write notes via Vault API");
vault.write("hello.md", "# Hello\n\nThis note was written by the Chamber Notes API.\n");
vault.write("ideas/brainstorm.md", "# Brainstorm\n\n- idea one\n- idea two\n");
console.log("  Written: hello.md");
console.log("  Written: ideas/brainstorm.md");

// ── 2. List ───────────────────────────────────────────────────────────────────

section("2. list");
const files = vault.list();
files.forEach((f) => console.log(`  ${f}`));

// ── 3. Read ───────────────────────────────────────────────────────────────────

section("3. read hello.md");
console.log(vault.read("hello.md"));

// ── 4. External (human) edit — bypasses API ───────────────────────────────────

section("4. External human edit (fs.appendFileSync directly to disk)");
const externalPath = path.join(DEMO_ROOT, "hello.md");
fs.appendFileSync(externalPath, "\n> _Human-added postscript, bypassing the API._\n", "utf-8");
console.log("  External edit applied to hello.md on disk.");

section("4b. Read hello.md after external edit — change is visible");
console.log(vault.read("hello.md"));

// ── 5. External new file created directly on disk ─────────────────────────────

section("5. Human creates a NEW file directly on disk (outside API)");
fs.writeFileSync(
  path.join(DEMO_ROOT, "human-created.md"),
  "# Human Created\n\nThis file was dropped directly on disk.\n",
  "utf-8"
);
console.log("  Created human-created.md on disk.");

section("5b. list after human-created file — it appears");
vault.list().forEach((f) => console.log(`  ${f}`));

// ── 6. append via API ─────────────────────────────────────────────────────────

section("6. append via API");
vault.append("ideas/brainstorm.md", "- idea three (appended via API)\n");
console.log("  Appended to ideas/brainstorm.md");
console.log(vault.read("ideas/brainstorm.md"));

// ── 7. Safety: non-.md path rejected ─────────────────────────────────────────

section("7. Safety: non-.md paths are rejected");
expectError("write script.js", () => vault.write("script.js", "alert('pwned')"));
expectError("write evil.sh",   () => vault.write("evil.sh", "#!/bin/sh\nrm -rf /"));
expectError("write no-ext",    () => vault.write("noextension", "data"));

// ── 8. Safety: path traversal rejected ────────────────────────────────────────

section("8. Safety: path traversal is rejected");
expectError("../escape.md",          () => vault.write("../escape.md", "escaped!"));
expectError("subdir/../../out.md",   () => vault.write("subdir/../../out.md", "escaped!"));
expectError("/absolute/path.md",     () => vault.write("/absolute/path.md", "abs"));
expectError("~/home-escape.md",      () => vault.write("~/home-escape.md", "home"));

// ── 9. Remove ─────────────────────────────────────────────────────────────────

section("9. remove human-created.md via API");
vault.remove("human-created.md");
console.log("  Removed human-created.md");

section("9b. Final list");
vault.list().forEach((f) => console.log(`  ${f}`));

console.log(`\n${"═".repeat(60)}`);
console.log("  Demo complete. All safety checks passed.");
console.log("═".repeat(60));
