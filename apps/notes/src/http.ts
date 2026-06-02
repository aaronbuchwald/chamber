import { serveHttp } from "../../../packages/appkit/src/index.js";
import { app } from "./app.js";

serveHttp(app);
