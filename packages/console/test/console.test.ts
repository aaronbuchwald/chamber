/**
 * console.test.ts — smoke test for the generic console component.
 *
 * The console is a pure function of an app's public operation metadata: given an
 * AppDef it returns a self-contained HTML document that names each operation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type AppDef, defineApp } from "@chamber/datagram";
import { consoleHtml } from "../src/index.js";

function fakeApp(): AppDef {
  return defineApp({
    name: "demo",
    version: "1.2.3",
    operations: [
      {
        name: "list_things",
        summary: "List the things",
        jsonSchema: { type: "object", properties: {} },
        validate: (body) => ({ ok: true, value: body }),
        handler: () => [],
        mutates: false,
      },
      {
        name: "add_thing",
        summary: "Add a thing",
        jsonSchema: { type: "object", properties: { name: { type: "string" } } },
        validate: (body) => ({ ok: true, value: body }),
        handler: () => ({ id: "1" }),
        mutates: true,
      },
    ],
  });
}

test("consoleHtml returns an HTML document containing the op names", () => {
  const html = consoleHtml(fakeApp());
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes("list_things"), "names the list_things op");
  assert.ok(html.includes("add_thing"), "names the add_thing op");
  assert.ok(html.includes("demo"), "names the app");
  assert.ok(html.includes("v1.2.3"), "shows the app version");
  // It wires the live SSE stream + posts to the per-op routes.
  assert.ok(html.includes("/events"), "subscribes to the SSE stream");
});

test("consoleHtml escapes HTML-significant characters in the app name", () => {
  const app = defineApp({ name: "<b>x</b>", version: "0.0.0", operations: [] });
  const html = consoleHtml(app);
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"), "app name is HTML-escaped in the title/header");
});
