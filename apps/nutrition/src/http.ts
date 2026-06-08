import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveHttp } from "../../../packages/appkit/src/index.js";
import { app } from "./app.js";

// Serve the static UI (apps/nutrition/public) same-origin alongside the API,
// so the browser's POST /list_meals etc. need no CORS.
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

serveHttp(app, Number(process.env.PORT) || 8787, { staticDir: publicDir });
