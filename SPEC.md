# Chamber — Specification

*Sandboxed, portable MCP servers.*

**Status:** Draft v0.1
**Date:** 2026-06-02

---

## 1. Summary

Chamber is a standard for writing [Model Context Protocol](https://modelcontextprotocol.io) servers as **capability‑sandboxed WebAssembly components**. A server authored once runs *unmodified* in three host profiles:

1. **Local** — a single self‑hostable binary on your machine.
2. **Browser** — entirely in‑page (WASM + a Web Worker), no server required.
3. **Edge** — a V8 isolate in a Cloudflare Worker (or any WinterCG runtime).

A Chamber server has **zero ambient authority**. It cannot open sockets, spawn processes, or touch the filesystem. The host hands it a small, explicit set of capabilities. The flagship capability is a **Markdown Document Store**: the server may read and write **raw UTF‑8 text** into `.md` files inside a directory it has been granted — and *only* that. The store never interprets or executes its contents; it is inert data by construction.

The same Document Store can be backed by a real directory (local), OPFS (browser), or object storage + a coordinator (edge), and can be **synced across all of them with a CRDT** so a server's data follows the user across devices and between local and hosted deployments.

### Why this exists

Today an MCP server is an arbitrary program with the full authority of the process that launches it. That makes servers hard to trust, hard to sandbox, and tied to one runtime. Chamber inverts this: a server is a portable, least‑privilege artifact scoped to *its own data*, interchangeable across local / remote / edge, and trivial to self‑host.

---

## 2. Goals and non‑goals

### Goals

- **One artifact, three hosts.** A compiled component runs identically locally, in a browser, and on Cloudflare.
- **Least authority by default.** No network, no filesystem, no exec unless explicitly granted in a manifest and confirmed by the host.
- **Data‑scoped servers.** The default capability is "write text into my markdown folder," nothing more.
- **Inert data.** Servers write *text*, never executable code; nothing the server stores can later be run.
- **Effortless self‑hosting.** `chamberd run ./server.wasm` should be the whole story locally.
- **Device sync without a rewrite.** A CRDT layer lets the same vault live on a laptop, a phone's browser, and an edge deployment, converging automatically.

### Non‑goals

- Replacing the MCP wire protocol. Chamber servers speak ordinary MCP to clients; sandboxing is an implementation contract, not a new client protocol.
- General‑purpose compute sandboxing. The capability set is small and curated, not a full POSIX shim.
- Defining the AI client. Any MCP‑compatible client works unchanged.

---

## 3. Terminology

| Term | Meaning |
|---|---|
| **Component** | A WebAssembly [Component Model](https://component-model.bytecodealliance.org/) module implementing the Chamber world. The unit of distribution. |
| **Host** | The runtime that instantiates a component, implements its imported capabilities, and bridges MCP traffic. One of the three host profiles. |
| **World** | The WIT contract (`mcp-server`) defining what a component imports and exports. |
| **Vault** | A granted directory of markdown documents — the Document Store's unit of scope. |
| **Doc** | A single `.md` file within a vault. |
| **Block** | A CRDT‑addressable unit within a doc (a paragraph, heading, list item, fenced code span, etc.). |
| **Grant** | An entry in the manifest, confirmed by the host/user, authorizing one capability. |
| **Replica** | One host's local copy of a vault's CRDT state. |

---

## 4. Architecture

```
        ┌──────────────────────────────────────────────────────┐
        │                     MCP Client                        │
        │            (Claude, IDE, CLI, browser app)            │
        └───────────────────────────┬──────────────────────────┘
                                     │  MCP wire protocol
                                     │  (stdio | Streamable HTTP | in‑page)
        ┌───────────────────────────▼──────────────────────────┐
        │                        Host                           │
        │  ┌─────────────┐   ┌──────────────────────────────┐  │
        │  │ MCP shim    │   │ Capability providers          │  │
        │  │ (wire ⇄ WIT)│   │  • doc-store (markdown vault)  │  │
        │  └──────┬──────┘   │  • clock / random / log (opt)  │  │
        │         │          │  • fetch (opt, host-policed)   │  │
        │  ┌──────▼───────────────────────┐                    │
        │  │   WASM component (sandbox)    │  imports ──────────┘
        │  │   exports: init/call-tool/... │
        │  └───────────────────────────────┘
        │         │ doc-store ops                                │
        │  ┌──────▼───────────────────────┐   ┌──────────────┐  │
        │  │   Vault backend (per profile) │◄─►│  CRDT engine  │  │
        │  │   dir | OPFS | R2+coordinator │   │  (sync/merge) │  │
        │  └───────────────────────────────┘   └──────┬───────┘  │
        └────────────────────────────────────────────┼──────────┘
                                                      │ sync protocol
                                              ┌───────▼────────┐
                                              │ other replicas  │
                                              │ (devices/edge)  │
                                              └─────────────────┘
```

The component never sees the MCP wire format and never sees raw storage. It speaks a **typed WIT surface**; the host translates to/from JSON‑RPC and to/from whatever storage backs the vault.

---

## 5. The contract (WIT world)

Chamber is defined by a WIT package. A conformant component targets the `mcp-server` world; a conformant host implements every import and drives every export.

```wit
package chamber:server@0.1.0;

interface types {
  /// A JSON value encoded as a UTF‑8 string (object/array/etc.).
  type json = string;

  record tool-descriptor {
    name: string,
    title: string,
    description: string,
    input-schema: json,   // JSON Schema for arguments
  }

  record tool-call {
    name: string,
    arguments: json,      // JSON object matching input-schema
    call-id: string,
  }

  variant content-block {
    text(string),
    resource-link(resource-ref),
  }

  record resource-ref {
    uri: string,
    mime: string,
  }

  record tool-result {
    content: list<content-block>,
    is-error: bool,
  }

  variant error {
    invalid-input(string),
    not-found(string),
    forbidden(string),       // capability not granted / path rule violated
    quota-exceeded(string),
    conflict(string),
    internal(string),
  }
}

/// The Markdown Document Store — the flagship capability.
interface doc-store {
  use types.{error};

  type block-id = string;   // opaque, stable across replicas

  record block {
    id: block-id,
    text: string,           // raw markdown source for this block
  }

  record doc-stat {
    path: string,
    bytes: u64,
    modified-unix-ms: u64,
    revision: string,       // opaque CRDT version (hash of state vector)
  }

  /// A handle to one granted vault. The host scopes all paths to its root.
  resource vault {
    /// Relative `.md` paths, sorted.
    list: func() -> result<list<string>, error>;

    /// Whole‑document text operations. Text is stored verbatim and never executed.
    read:   func(path: string) -> result<string, error>;
    write:  func(path: string, text: string) -> result<_, error>;   // overwrite/create
    append: func(path: string, text: string) -> result<_, error>;   // append/create
    remove: func(path: string) -> result<_, error>;
    stat:   func(path: string) -> result<doc-stat, error>;

    /// Block‑level operations (CRDT‑friendly, merge‑safe).
    blocks:        func(path: string) -> result<list<block>, error>;
    insert-block:  func(path: string, after: option<block-id>, text: string)
                     -> result<block-id, error>;
    replace-block: func(path: string, id: block-id, text: string) -> result<_, error>;
    remove-block:  func(path: string, id: block-id) -> result<_, error>;
  }

  /// Open a vault by the logical name declared in the manifest.
  /// Fails with `forbidden` if no matching grant exists.
  open: func(name: string) -> result<vault, error>;
}

/// Structured logging to the host (no stdout/stderr available in the sandbox).
interface logging {
  enum level { trace, debug, info, warn, error }
  log: func(level: level, message: string);
}

/// The server's MCP surface, called by the host.
interface server {
  use types.{tool-descriptor, tool-call, tool-result, content-block, resource-ref, error};

  record server-info {
    name: string,
    version: string,
    instructions: string,
    tools: list<tool-descriptor>,
  }

  /// Called once after instantiation. Returns identity + advertised tools.
  init: func() -> result<server-info, error>;

  /// Invoked per `tools/call`.
  call-tool: func(call: tool-call) -> tool-result;

  /// Optional resource surface (`resources/list`, `resources/read`).
  list-resources: func() -> result<list<resource-ref>, error>;
  read-resource:  func(uri: string) -> result<list<content-block>, error>;
}

world mcp-server {
  import doc-store;
  import logging;
  import wasi:clocks/wall-clock@0.2.0;   // gated; only if `clock` granted
  import wasi:random/random@0.2.0;       // gated; only if `random` granted
  // import fetch;                        // gated; host‑policed allowlist only
  export server;
}
```

Notes:

- The component speaks **typed values**, not JSON‑RPC. The host's MCP shim maps `tools/list` → cached `init().tools`, `tools/call` → `call-tool`, etc. Authors never reimplement transport.
- Gated imports (`clock`, `random`, `fetch`) are only *present in the instantiated world* when the corresponding grant exists. A component that imports a capability it wasn't granted fails to instantiate — fail‑closed, not fail‑at‑use.
- `json` is carried as a string to keep the WIT surface small and to avoid binding a specific JSON ABI; hosts validate against `input-schema`.

---

## 6. The Markdown Document Store

The Document Store is the heart of the default sandbox. Its rules are normative.

### 6.1 What may be written

- **Only** files whose path ends in `.md` (or `.markdown`). Any other extension → `forbidden`. This is the mechanism that keeps the store inert: a server cannot drop a `.js`, `.wasm`, `.sh`, or dotfile that some other process might later execute.
- Content MUST be valid UTF‑8. Invalid sequences → `invalid-input`.
- Content is stored **verbatim**. The store does not parse, render, expand, or execute it. YAML frontmatter, code fences, and HTML in the markdown are *data*, never instructions to the store.

### 6.2 Path rules (host‑enforced)

- Paths are relative to the vault root. Leading `/`, `..` segments, `~`, drive letters, NUL bytes, and control characters → `forbidden`.
- The host resolves the final path and verifies it remains within the vault root (defeating symlink/junction traversal on backends that have them).
- Path length and segment‑depth limits apply (defaults: 1024 bytes, 32 segments).

### 6.3 Quotas

The host enforces, with `quota-exceeded` on breach:

| Limit | Default | Configurable |
|---|---|---|
| Max doc size | 4 MiB | yes |
| Max vault size | 256 MiB | yes |
| Max docs per vault | 10,000 | yes |
| Max blocks per doc | 50,000 | yes |

### 6.4 Rendering safety (consumer‑side)

Storage is inert, but any host that *renders* stored markdown for a human MUST sanitize: strip `<script>`, event‑handler attributes, and `javascript:` / `data:` URLs, per a referenced allowlist (e.g. a CommonMark renderer with raw‑HTML disabled). This is a host obligation, separate from storage.

### 6.5 Blocks vs. whole‑doc ops

A doc is internally a **sequence of blocks**. `write`/`append` are convenience operations the host diffs into block ops. Authors that want merge‑clean, sync‑friendly edits should prefer `insert-block` / `replace-block` / `remove-block`, which map 1:1 onto CRDT operations (§9). Block IDs are stable across replicas.

---

## 7. Host profiles

All three profiles implement the identical `mcp-server` world. They differ only in how `doc-store` is backed and how MCP traffic arrives.

### 7.1 Local (`chamberd`)

- Runtime: a Wasmtime‑based daemon. Single static binary.
- Vault backend: a real directory, e.g. `~/.local/share/sp-mcp/vaults/<name>/`. Docs are plain `.md` files on disk — readable and editable by the user with any editor.
- MCP transport: **stdio** (for desktop clients that spawn the server) and **Streamable HTTP** (for networked clients).
- Self‑host: `chamberd run ./journal.wasm --vault journal=~/notes/journal`.

### 7.2 Browser

- Runtime: the component is transpiled to JS + core WASM with [`jco`](https://github.com/bytecodealliance/jco) and run in a **Web Worker** (off the main thread, isolated).
- Vault backend: the [Origin Private File System (OPFS)](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system). Docs persist in the browser; nothing leaves the device unless sync is on.
- MCP transport: in‑page (the client and host live in the same page) or a `MessagePort`/`postMessage` bridge.
- No server, no install. Sync (§9) is optional and over WebSocket/WebRTC.

### 7.3 Edge (Cloudflare Worker)

- Runtime: the transpiled component runs inside the Worker's **V8 isolate**.
- Vault backend: **R2** for document blobs + a **Durable Object** that owns the vault's CRDT state and serializes writes/sync. (KV may back small metadata.)
- MCP transport: **Streamable HTTP** at a Worker route.
- Self‑host equivalent: `wrangler deploy`. The same artifact you ran locally.

| Concern | Local | Browser | Edge (CF) |
|---|---|---|---|
| WASM runtime | Wasmtime | jco → WASM in Worker | jco → WASM in V8 isolate |
| Vault backend | directory | OPFS | R2 + Durable Object |
| MCP transport | stdio / HTTP | in‑page / port | Streamable HTTP |
| Sync role | replica / peer | replica / peer | replica + coordinator |

---

## 8. MCP protocol mapping

The host's shim is the only component that knows MCP‑on‑the‑wire.

| MCP method | Host behavior |
|---|---|
| `initialize` | Host responds with capabilities; lazily calls `server.init()` and caches `server-info`. |
| `tools/list` | Returns cached `server-info.tools`. |
| `tools/call` | Validates `arguments` against the tool's `input-schema`, then invokes `call-tool`. Maps `tool-result` → MCP result; `is-error` → tool error. |
| `resources/list` | Calls `list-resources` (empty if unimplemented). |
| `resources/read` | Calls `read-resource`. |
| `ping` | Host‑local. |

`init()` failures surface as an initialization error; per‑call `error` variants map to MCP error codes (`invalid-input` → `-32602`, `forbidden`/`quota-exceeded`/`conflict` → server‑defined application errors with structured `data`).

---

## 9. Sync (CRDT)

Sync is what makes "interchangeably local, remote, and hosted" real: the *same vault* can live on several replicas and converge without a central authority being mandatory.

### 9.1 Model

- Each doc is a **CRDT document**: a sequence CRDT over blocks (à la Yjs/Automerge), where block order is a sequence CRDT and each block's text is a text CRDT (or last‑writer‑wins per block, configurable). Recommended baseline: **Automerge** or **Yjs**, profile‑pinned for byte‑identical serialization.
- The on‑disk/OPFS/R2 `.md` file is a **materialized view** produced by a *canonical* serializer: given identical CRDT state, every replica emits byte‑identical markdown. This keeps plain‑file editing (local) and CRDT sync coherent.
- `insert-block`/`replace-block`/`remove-block` map directly to CRDT ops. `write`/`append` are diffed against current blocks into the minimal op set.

### 9.2 External edits

When a user edits a local `.md` file directly (or a tool outside Chamber does), the local host detects the change (mtime/hash), re‑parses to blocks, and computes a CRDT diff so the edit participates in sync. Block IDs are matched by content/position heuristics; unmatched blocks are treated as insert+delete.

### 9.3 Sync protocol

- Replicas exchange **state vectors** then **op/update deltas** (standard CRDT sync). Transport is WebSocket (browser/edge) or HTTP long‑poll (local↔edge).
- The Cloudflare **Durable Object** is the natural **coordinator/relay**: it holds authoritative CRDT state for a vault and fans out updates. Peer‑to‑peer (WebRTC) is allowed where no coordinator exists.
- Offline replicas merge cleanly on reconnect; there is no "merge conflict" failure mode — concurrent edits to the same block merge via the text CRDT, and concurrent structural edits resolve by the sequence CRDT's deterministic order.

### 9.4 Convergence guarantee

Two replicas that have exchanged all ops MUST (a) hold identical CRDT state and (b) materialize byte‑identical `.md` files. Conformance includes a fuzz test for this (§13).

---

## 10. Manifest and grants

A component carries a manifest (a WIT‑component custom section, mirrored by a `chamber.toml` for authoring). The host reads it, presents the requested capabilities to the user, and instantiates the world with exactly the confirmed grants.

```toml
[server]
name    = "journal"
version = "0.1.0"
instructions = "A private journaling MCP server scoped to one markdown vault."

# The flagship capability: one or more markdown vaults.
[[grants.vault]]
name   = "journal"          # logical name passed to doc-store.open()
access = "read-write"       # read | read-write
sync   = "optional"         # off | optional | required

# Gated, off by default. Each one, if present, adds an import to the world.
[grants]
clock  = true
random = false

[grants.fetch]               # absent = no network at all
allow  = ["https://api.example.com/"]   # host‑policed prefix allowlist
```

Rules:

- A grant the user declines means the corresponding import is **absent** from the instantiated world → the component fails to instantiate if it requires it. Fail‑closed.
- A component can `open` only vaults named in `grants.vault`. Cross‑vault access is impossible.
- `fetch`, if ever granted, is host‑policed: prefix allowlist, no redirects off‑list, per‑request size/time caps, and no access to internal/metadata IP ranges.

---

## 11. Security model

**Trust boundary:** the WASM sandbox. The component has no ambient authority; its entire reachable surface is the imports in its instantiated world.

| Risk | Mitigation |
|---|---|
| Filesystem escape | No FS import. Only `doc-store`, path‑validated, root‑scoped, `.md`‑only. |
| Code execution / drop‑and‑run | Store rejects non‑`.md`; content is never interpreted; rendering hosts sanitize. |
| Network exfiltration | No network unless `fetch` granted; then prefix‑allowlisted and SSRF‑guarded. |
| Resource exhaustion (CPU) | Wasmtime fuel / epoch interruption; per‑call wall‑clock timeout. |
| Resource exhaustion (memory) | Component memory cap (default 64 MiB). |
| Resource exhaustion (storage) | Vault/doc/block quotas (§6.3). |
| Cross‑vault / cross‑tenant leakage | Vault handles are grant‑scoped; edge isolation per Durable Object + namespaced R2 prefixes. |
| Supply‑chain tampering | Components are content‑addressed (SHA‑256); optional signature (e.g. Sigstore) recorded in the manifest; host can pin hashes. |
| Malicious markdown reaching a renderer | Consumer‑side sanitization is a normative host obligation (§6.4). |

Capabilities follow **POLA** (principle of least authority): the default server can do exactly one thing — keep text in its own folder.

---

## 12. Packaging and distribution

- **Unit:** a single `.wasm` Component Model binary with an embedded manifest section.
- **Identity:** content hash (`sha256:…`); human name + semver from the manifest.
- **Registry (optional):** an OCI‑artifact or simple HTTPS index serving components by name+version+hash. Install = fetch + verify hash (+ signature) + show grants for confirmation.
- **Reproducible builds** are recommended so a published hash can be independently rebuilt.

---

## 13. Conformance

A reference test suite (`chamber-conformance`) that any host or component can run:

**Host conformance**
- Implements every `mcp-server` import; rejects ungranted imports at instantiation.
- Enforces all path rules and quotas (negative tests: `..`, absolute, non‑`.md`, oversize).
- MCP mapping round‑trips (`initialize`/`tools/list`/`tools/call`/`resources/*`).
- Applies CPU/memory/timeout limits.

**Component conformance**
- `init()` returns a valid `server-info` with JSON‑Schema‑valid tool descriptors.
- Tools behave identically across all three host profiles given the same vault state ("write‑once, run‑anywhere" golden tests).

**Sync conformance**
- Convergence fuzz: random concurrent op streams across N replicas → identical CRDT state and byte‑identical materialized `.md` (§9.4).
- Offline/merge and external‑edit reconciliation tests.

A component/host that passes is "Chamber 0.1 conformant."

---

## 14. Worked example: a journaling server

A minimal server exposing two tools, scoped to one vault.

**`chamber.toml`**
```toml
[server]
name = "journal"
version = "0.1.0"
instructions = "Append dated entries to a private markdown journal."

[[grants.vault]]
name = "journal"
access = "read-write"
sync = "optional"

[grants]
clock = true
```

**Behavior (pseudo‑Rust against the generated WIT bindings):**
```rust
fn init() -> Result<ServerInfo, Error> {
    Ok(ServerInfo {
        name: "journal".into(),
        version: "0.1.0".into(),
        instructions: "Append dated entries to a private markdown journal.".into(),
        tools: vec![
            tool("add_entry", "Add a journal entry",
                 schema!({ "text": "string" })),
            tool("read_today", "Read today's entries", schema!({})),
        ],
    })
}

fn call_tool(call: ToolCall) -> ToolResult {
    let vault = doc_store::open("journal")?;             // grant‑scoped
    let today = wall_clock::now().date();                // clock granted
    let path = format!("{today}.md");                    // .md only — allowed
    match call.name.as_str() {
        "add_entry" => {
            let text = call.args["text"].as_str();
            vault.append(&path, &format!("\n- {text}\n"))?;   // inert text
            ok_text("entry added")
        }
        "read_today" => ok_text(&vault.read(&path).unwrap_or_default()),
        _ => err("unknown tool"),
    }
}
```

The identical `journal.wasm`:
- runs locally as `chamberd run journal.wasm` writing to `~/notes/journal/2026-06-02.md`,
- runs in a browser tab writing to OPFS,
- runs on Cloudflare writing to R2 behind a Durable Object,
- and, with `sync = "optional"` turned on, keeps all three in sync via CRDT.

It can do nothing else: no network, no other files, no code execution.

---

## 15. Open questions

1. **JSON ABI.** Carrying `json` as a string is simple but pushes parsing into the component. Worth a typed `value` variant later?
2. **Streaming tool results.** MCP supports progress/partial results; the current `call-tool` is request/response. Add an async/stream export?
3. **CRDT pinning.** Automerge vs. Yjs as the normative baseline — pick one for 0.1 to guarantee cross‑impl convergence, or define a serialization‑level spec both can satisfy?
4. **Prompts & sampling.** MCP `prompts/*` and sampling are unmapped in 0.1; add to `server` interface when needed.
5. **Multi‑vault sync topologies.** Coordinator election when several edge regions + several devices all hold replicas.
6. **Capability beyond markdown.** A future `kv-store` or `blob-store` capability with the same inert‑data discipline?

---

## Appendix A — Why WASM Component Model + WASI 0.2

- **Portability across exactly our three targets:** Wasmtime (local), jco transpilation (browser and Cloudflare Workers) all consume the same component. No per‑target rewrite.
- **Capabilities are native.** WASI 0.2's import‑based design *is* a capability system; least authority is the default, not bolted on.
- **Language‑agnostic authoring.** Rust, JS/TS, Go (TinyGo), Python, etc. compile to components.
- **Strong isolation primitives.** Memory isolation, fuel/epoch CPU limits, and explicit imports give a tractable threat model.
