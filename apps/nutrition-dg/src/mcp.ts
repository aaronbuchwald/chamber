/**
 * mcp.ts — serve the nutrition datagram as an MCP stdio server.
 *
 * Each action becomes one MCP tool whose inputSchema is the proto-derived
 * JSON-Schema. A direct stdio server has no SSE subscribers of its own; route
 * MCP writes through the HTTP process (or a gateway) for cross-front-end live
 * views, as the v0 plan notes.
 */

import { serveMcp } from "@chamber/datagram";
import { buildNutritionDatagram } from "./service.js";

const { app } = buildNutritionDatagram({ dbPath: process.env.DB_PATH ?? "nutrition-dg.db" });
await serveMcp(app);
