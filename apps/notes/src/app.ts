/**
 * app.ts — the notes app's operation registry (single source of truth).
 *
 * These five operations are declared once (name + zod input + handler over the
 * existing Vault core) and are served identically as a CLI, an HTTP+OpenAPI API,
 * and an MCP server via @chamber/appkit.
 */
import { defineApp, z } from "../../../packages/appkit/src/index.js";
import { Vault } from "./vault.js";

const vault = new Vault(process.env.CHAMBER_NOTES_ROOT || "vault");

export const app = defineApp({
  name: "notes",
  version: "0.1.0",
  operations: [
    {
      name: "list",
      summary: "List all markdown files in the vault.",
      input: z.object({}),
      handler: () => vault.list(),
    },
    {
      name: "read",
      summary: "Read a note from the vault.",
      input: z.object({
        path: z.string().describe("Relative path to the note, e.g. 'hello.md'"),
      }),
      handler: ({ path }) => vault.read(path),
    },
    {
      name: "write",
      summary: "Create or overwrite a note. Only .md / .markdown files allowed.",
      input: z.object({
        path: z.string().describe("Relative path for the note, e.g. 'ideas/todo.md'"),
        text: z.string().describe("Full content to write to the file"),
      }),
      handler: ({ path, text }) => { vault.write(path, text); return `wrote ${path}`; },
    },
    {
      name: "append",
      summary: "Append text to an existing note (creates if missing).",
      input: z.object({
        path: z.string().describe("Relative path to the note"),
        text: z.string().describe("Text to append to the file"),
      }),
      handler: ({ path, text }) => { vault.append(path, text); return `appended ${path}`; },
    },
    {
      name: "remove",
      summary: "Delete a note from the vault.",
      input: z.object({
        path: z.string().describe("Relative path to the note to delete"),
      }),
      handler: ({ path }) => { vault.remove(path); return `removed ${path}`; },
    },
  ],
});
