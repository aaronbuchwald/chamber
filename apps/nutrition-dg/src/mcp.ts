/**
 * mcp.ts — serve the nutrition datagram as an MCP stdio server.
 *
 * Each action becomes one MCP tool whose inputSchema is the proto-derived
 * JSON-Schema. A direct stdio server has no SSE subscribers of its own; route
 * MCP writes through the HTTP process (or a gateway) for cross-front-end live
 * views, as the v0 plan notes.
 */

import { serveMcp } from "@chamber/datagram";
import { APP_DIR, buildNutritionDatagram } from "./service.js";
import { selectStrategy } from "./strategies.js";

const { app } = buildNutritionDatagram({
  dbPath: process.env.DB_PATH ?? "nutrition-dg.db",
  strategy: selectStrategy(process.env.NUTRITION_STRATEGY, APP_DIR),
});
await serveMcp(app);
