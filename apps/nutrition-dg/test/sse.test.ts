/**
 * sse.test.ts — §7 acceptance item 5 (live view).
 *
 * Proves that a `mutates` write through the HTTP server pushes an SSE event to a
 * connected /events client — the mechanism the /ui console uses to refresh open
 * views when a write arrives from another front-end (the MCP tool, a gateway, or
 * the SPA itself). A read (list_meals) must NOT push.
 */

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { serveHttp } from "@chamber/datagram";
import { buildNutritionDatagram } from "../src/service.js";

const { app, close } = buildNutritionDatagram();
const server = serveHttp(app, 0); // ephemeral port
after(() => {
  server.close();
  close();
});

function baseUrl(): string {
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Open an SSE stream and resolve with the first `data:` event's payload (or reject on timeout). */
async function firstSseEvent(timeoutMs: number): Promise<{ op: string; at: number }> {
  const res = await fetch(`${baseUrl()}/events`, { headers: { accept: "text/event-stream" } });
  assert.ok(res.body, "SSE response has a body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timed out waiting for SSE event")), timeoutMs),
  );
  const read = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream closed before an event arrived");
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          const json = trimmed.slice("data:".length).trim();
          if (json) return JSON.parse(json) as { op: string; at: number };
        }
      }
    }
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

test("live view: a mutating write pushes an SSE event to a connected /events client", async () => {
  // Subscribe BEFORE writing, then trigger the write once the stream is open.
  const eventPromise = firstSseEvent(5000);
  // Give the SSE connection a tick to register before the mutation fires.
  await new Promise((r) => setTimeout(r, 100));

  const resp = await fetch(`${baseUrl()}/log_meal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: "oatmeal" }),
  });
  assert.equal(resp.status, 200);

  const evt = await eventPromise;
  assert.equal(evt.op, "log_meal", "the mutation event names the write op");
  assert.equal(typeof evt.at, "number");
});

test("a read (list_meals) does NOT push an SSE event", async () => {
  // No event should arrive within the window when only a read is issued.
  let pushed = false;
  firstSseEvent(800)
    .then(() => {
      pushed = true;
    })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  const resp = await fetch(`${baseUrl()}/list_meals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(resp.status, 200);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(pushed, false, "reads are silent on the mutation bus");
});
