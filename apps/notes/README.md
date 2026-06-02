# Chamber Notes — prototype

A sandboxed markdown vault CLI. Stores notes as plain `.md` files; enforces host-style safety rules so the store stays inert and non-executable.

## Run instructions

```bash
cd apps/notes
npm install
npm run demo        # runs the end-to-end demonstration
```

To use the CLI directly:

```bash
npx tsx src/cli.ts [--root <dir>] <command> [args...]

# Examples
npx tsx src/cli.ts list
npx tsx src/cli.ts write notes/hello.md "# Hello world"
npx tsx src/cli.ts read  notes/hello.md
npx tsx src/cli.ts append notes/hello.md "more text"
npx tsx src/cli.ts remove notes/hello.md
```

Root directory defaults to `./vault` or `$CHAMBER_NOTES_ROOT`.

## Safety rules enforced

1. **Extension allow-list** — only `.md` / `.markdown` may be written or created. Drops of `.js`, `.sh`, `.wasm`, etc. are rejected at the API boundary.
2. **Path traversal prevention** — absolute paths, `..` segments, leading `~`, and NUL/control characters are all rejected before any filesystem access.
3. **Vault root confinement** — the resolved path is checked to remain inside the vault root even after symlink resolution.
4. **Content verbatim** — text is stored as UTF-8 bytes; never parsed, templated, or executed.
5. **Human-editable** — files are plain `.md` on disk, so external editors and the API share the same source of truth.
