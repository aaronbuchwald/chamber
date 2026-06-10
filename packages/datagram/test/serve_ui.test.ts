/**
 * serve_ui.test.ts — the neutral UI mounting on the HTTP front-end.
 *
 * The datagram SDK ships NO UI of its own. GET /ui is a 404 unless the caller
 * mounts a UI component via the `ui` option:
 *   - `{ html }` serves a pre-rendered string at /ui (how an app opts into the
 *     generic @chamber/console component).
 *   - `{ dir }` serves a static directory's index.html at /ui and sibling assets
 *     at /ui/*, with traversal protection.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type AppDef, type ServeHttpOptions, defineApp, serveHttp } from "../src/index.js";

function fakeApp(): AppDef {
  return defineApp({
    name: "demo",
    version: "0.0.0",
    operations: [
      {
        name: "list_things",
        summary: "List the things",
        jsonSchema: { type: "object", properties: {} },
        validate: (body) => ({ ok: true, value: body }),
        handler: () => [],
        mutates: false,
      },
    ],
  });
}

function url(server: { address(): AddressInfo | string | null }, path: string): string {
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}${path}`;
}

async function withServer(opts: ServeHttpOptions, fn: (base: string) => Promise<void>) {
  const server = serveHttp(fakeApp(), 0, opts);
  try {
    await fn(url(server, ""));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("no ui option → GET /ui is 404 (the datagram layer stays UI-free)", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/ui`);
    assert.equal(res.status, 404);
    // The metadata root advertises no ui link when none is mounted.
    const meta = (await (await fetch(`${base}/`)).json()) as { ui?: string };
    assert.equal(meta.ui, undefined);
  });
});

test("ui: { html } → GET /ui serves the provided string", async () => {
  await withServer({ ui: { html: "<!doctype html><h1>hello console</h1>" } }, async (base) => {
    const res = await fetch(`${base}/ui`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.ok((await res.text()).includes("hello console"));
    const meta = (await (await fetch(`${base}/`)).json()) as { ui?: string };
    assert.equal(meta.ui, "/ui", "metadata advertises the mounted UI");
  });
});

test("ui: { dir } → /ui serves index.html and /ui/* serves assets, with traversal blocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "datagram-ui-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "index.html"), "<!doctype html><h1>app ui</h1>");
  writeFileSync(join(dir, "app.js"), "console.log('hi')");

  await withServer({ ui: { dir } }, async (base) => {
    const index = await fetch(`${base}/ui`);
    assert.equal(index.status, 200);
    assert.ok((await index.text()).includes("app ui"));

    const asset = await fetch(`${base}/ui/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);

    // Path traversal must not escape the mount dir.
    const traversal = await fetch(`${base}/ui/..%2f..%2fetc%2fpasswd`);
    assert.ok(traversal.status === 403 || traversal.status === 404, "traversal is blocked");
  });
});
