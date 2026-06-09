/**
 * main.ts — the single entry point for the nutrition datagram.
 *
 * Builds the datagram ONCE (one schema, one SQLite handle, one mutation bus) and
 * then either:
 *   - `serve [--mcp] [--port N]` — long-running: composes controllers over that one
 *     instance via the SDK's `serve()`. HTTP is always on (API + /openapi.json + /ui +
 *     /events SSE); `--mcp` also attaches an MCP stdio controller. Because both
 *     controllers share the same instance and bus, an MCP write live-updates the open
 *     /ui console — no second process, no shared DB file, no gateway round-trip.
 *   - `<operation> [--flags]` — a one-shot CLI call over the same instance (e.g.
 *     `nutrition log_meal --description "oatmeal"`), then exits. (Per the v0 plan the
 *     CLI is a one-shot client, not a long-running controller.)
 */

import { parseArgs } from "node:util";
import { runCli, serve } from "@chamber/datagram";
import { APP_DIR, buildNutritionDatagram } from "./service.js";
import { selectStrategy } from "./strategies.js";

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;

const { app, close } = buildNutritionDatagram({
  dbPath: process.env.DB_PATH ?? "nutrition.db",
  strategy: selectStrategy(process.env.NUTRITION_STRATEGY, APP_DIR),
});

if (cmd === "serve") {
  // Parse the serve flags with node:util parseArgs: --mcp is a boolean, --port
  // takes a string we coerce to a number. A bare `--port` (or a non-numeric
  // value) is an explicit error rather than a silent fall-back to the default.
  let mcp = false;
  let port: number | undefined;
  try {
    const { values } = parseArgs({
      args: rest,
      options: { mcp: { type: "boolean" }, port: { type: "string" } },
      allowPositionals: false,
    });
    mcp = values.mcp ?? false;
    if (values.port !== undefined) {
      port = Number(values.port);
      if (!Number.isFinite(port) || port < 0) {
        throw new Error(`--port requires a numeric value (got "${values.port}")`);
      }
    }
  } catch (e) {
    console.error(`Invalid serve arguments: ${e instanceof Error ? e.message : String(e)}`);
    close();
    process.exit(1);
  }
  const handle = await serve(app, {
    http: port !== undefined ? { port } : {},
    mcp,
  });
  // Long-running: shut the controllers and the backend down cleanly on signals.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      handle.close().finally(() => {
        close();
        process.exit(0);
      });
    });
  }
} else {
  // One-shot CLI over the same instance, then release the DB handle.
  try {
    await runCli(app, argv);
  } finally {
    close();
  }
}
