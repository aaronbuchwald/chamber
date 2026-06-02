#!/usr/bin/env node
/**
 * cli.ts — Chamber Notes CLI
 *
 * Usage:
 *   npx tsx src/cli.ts [--root <dir>] <command> [args...]
 *
 * Commands:
 *   list
 *   read   <path>
 *   write  <path> <text>
 *   append <path> <text>
 *   remove <path>
 *
 * --root defaults to ./vault or CHAMBER_NOTES_ROOT env var.
 */

import { Vault, VaultError } from "./vault.js";
import * as path from "node:path";

function usage(): never {
  console.error(`
Chamber Notes CLI

  npx tsx src/cli.ts [--root <dir>] <command> [args...]

Commands:
  list
  read   <path>
  write  <path> <text>
  append <path> <text>
  remove <path>

Root defaults to ./vault or \$CHAMBER_NOTES_ROOT.
`.trim());
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);

  // Parse --root flag
  let root = process.env["CHAMBER_NOTES_ROOT"] ?? path.resolve("vault");
  const rootIdx = args.indexOf("--root");
  if (rootIdx !== -1) {
    const rootVal = args[rootIdx + 1];
    if (!rootVal) {
      console.error("--root requires a value");
      process.exit(1);
    }
    root = rootVal;
    args.splice(rootIdx, 2);
  }

  const [command, ...rest] = args;
  if (!command) usage();

  const vault = new Vault(root);

  try {
    switch (command) {
      case "list": {
        const files = vault.list();
        if (files.length === 0) {
          console.log("(vault is empty)");
        } else {
          files.forEach((f) => console.log(f));
        }
        break;
      }
      case "read": {
        const [filePath] = rest;
        if (!filePath) { console.error("read requires <path>"); process.exit(1); }
        console.log(vault.read(filePath));
        break;
      }
      case "write": {
        const [filePath, ...textParts] = rest;
        if (!filePath) { console.error("write requires <path> <text>"); process.exit(1); }
        vault.write(filePath, textParts.join(" "));
        console.log(`Written: ${filePath}`);
        break;
      }
      case "append": {
        const [filePath, ...textParts] = rest;
        if (!filePath) { console.error("append requires <path> <text>"); process.exit(1); }
        vault.append(filePath, textParts.join(" "));
        console.log(`Appended: ${filePath}`);
        break;
      }
      case "remove": {
        const [filePath] = rest;
        if (!filePath) { console.error("remove requires <path>"); process.exit(1); }
        vault.remove(filePath);
        console.log(`Removed: ${filePath}`);
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        usage();
    }
  } catch (err) {
    if (err instanceof VaultError) {
      console.error(`[VaultError] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

main();
