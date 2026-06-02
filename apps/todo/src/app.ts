/**
 * app.ts — the todo app's operation registry (single source of truth).
 *
 * These four operations are declared once (name + zod input + handler over the
 * existing core in todos.ts) and are served identically as a CLI, an
 * HTTP+OpenAPI API, and an MCP server via @chamber/appkit.
 */
import { defineApp, z } from "../../../packages/appkit/src/index.js";
import { add, setDone, list } from "./todos.js";

export const app = defineApp({
  name: "todo",
  version: "0.1.0",
  operations: [
    {
      name: "add",
      summary: "Add a new todo item.",
      input: z.object({
        text: z.string().describe("Text of the todo item to add"),
      }),
      handler: ({ text }) => {
        add(text);
        return `added: ${text}`;
      },
    },
    {
      name: "complete",
      summary: "Mark a todo item as completed.",
      input: z.object({
        index: z.number().int().positive().describe("1-based index of the item to complete"),
      }),
      handler: ({ index }) => {
        setDone(index, true);
        return `completed #${index}`;
      },
    },
    {
      name: "reopen",
      summary: "Re-open a completed todo item.",
      input: z.object({
        index: z.number().int().positive().describe("1-based index of the item to reopen"),
      }),
      handler: ({ index }) => {
        setDone(index, false);
        return `reopened #${index}`;
      },
    },
    {
      name: "list",
      summary: "List todo items, optionally filtered by status.",
      input: z.object({
        filter: z
          .enum(["all", "incomplete", "completed"])
          .optional()
          .describe('Filter: "all" (default), "incomplete", or "completed"'),
      }),
      handler: ({ filter }) =>
        list(filter === "all" || filter === undefined ? undefined : filter),
    },
  ],
});
