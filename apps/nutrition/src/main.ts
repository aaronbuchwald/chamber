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
  const portArg = rest[rest.indexOf("--port") + 1];
  const port = rest.includes("--port") && portArg ? Number(portArg) : undefined;
  const handle = await serve(app, {
    http: port ? { port } : {},
    mcp: rest.includes("--mcp"),
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
