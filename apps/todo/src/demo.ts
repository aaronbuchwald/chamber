/**
 * Demo script: seeds a fresh todos.md, performs operations, prints all views.
 * Run with: npm run demo
 */
import * as fs from "fs";
import * as path from "path";
import { add, setDone, list } from "./todos.js";

// Start fresh
const todosPath = path.join(process.cwd(), "todos.md");
if (fs.existsSync(todosPath)) fs.unlinkSync(todosPath);

// ── Seed data ──────────────────────────────────────────────────────────────
add("buy milk");
add("call dentist");
add("read Chamber spec");
add("ship prototype");

// Mark items 1 and 3 done
setDone(1, true);
setDone(3, true);

// ── Show the raw markdown (source of truth) ────────────────────────────────
console.log("=== todos.md (raw file) ===");
console.log(fs.readFileSync(todosPath, "utf8"));

// ── Views ──────────────────────────────────────────────────────────────────
function printTodos(todos: ReturnType<typeof list>, label: string): void {
  console.log(`=== ${label} ===`);
  if (todos.length === 0) {
    console.log("  (none)");
  } else {
    for (const t of todos) {
      const box = t.done ? "[x]" : "[ ]";
      console.log(`  ${t.index}. ${box} ${t.text}`);
    }
  }
  console.log();
}

printTodos(list(), "All items");
printTodos(list("incomplete"), "Incomplete");
printTodos(list("completed"), "Completed");
