#!/usr/bin/env node
import { runCli } from "../../../packages/appkit/src/index.js";
import { app } from "./app.js";

runCli(app, process.argv.slice(2));
