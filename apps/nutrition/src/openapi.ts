// Emit the generated OpenAPI 3.1 spec for this app (for the agentgateway hop).
//   npm run openapi > openapi.json
import { openApiDoc } from "../../../packages/appkit/src/index.js";
import { app } from "./app.js";

console.log(JSON.stringify(openApiDoc(app), null, 2));
