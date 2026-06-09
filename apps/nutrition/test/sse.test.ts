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
import { invokeOperation, onMutation, serveHttp } from "@chamber/datagram";
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

test("per-app bus isolation: a mutation on app A does NOT fire app B's mutation listener", async () => {
  // Two datagrams composed in ONE process must not cross-fire each other's
  // mutation events (the bug a process-global bus caused: every UI refreshing on
  // every other app's writes). The bus is scoped per AppDef, so a write dispatched
  // through app A only notifies A's listeners.
  const a = buildNutritionDatagram();
  const b = buildNutritionDatagram();
  try {
    let aFired = 0;
    let bFired = 0;
    const offA = onMutation(a.app, () => {
      aFired++;
    });
    const offB = onMutation(b.app, () => {
      bFired++;
    });

    const logA = a.app.operations.find((o) => o.name === "log_meal");
    assert.ok(logA);
    const parsed = logA.validate({ description: "oatmeal" });
    assert.ok(parsed.ok);
    await invokeOperation(a.app, logA, parsed.value);

    assert.equal(aFired, 1, "app A's listener saw A's write");
    assert.equal(bFired, 0, "app B's listener did NOT see A's write (buses are isolated)");
    offA();
    offB();
  } finally {
    a.close();
    b.close();
  }
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
