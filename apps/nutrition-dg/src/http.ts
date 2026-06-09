/**
 * http.ts — serve the nutrition datagram over HTTP + /openapi.json + /ui + /events.
 *
 * The generic /ui console (live via /events SSE) is the v0 generated WebUI: a
 * write that arrives from another front-end (the MCP tool, or a CLI/gateway call
 * routed to these HTTP routes) pushes a mutation event and the open console
 * re-runs its read views without a manual refresh.
 */

import { serveHttp } from "@chamber/datagram";
import { buildNutritionDatagram } from "./service.js";

const { app } = buildNutritionDatagram({ dbPath: process.env.DB_PATH ?? "nutrition-dg.db" });
serveHttp(app, Number(process.env.PORT) || 8788);
