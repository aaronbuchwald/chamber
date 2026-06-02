#!/usr/bin/env node
import { add, setDone, list } from "./todos.js";

function printTodos(todos: ReturnType<typeof list>, label: string): void {
  console.log(`\n=== ${label} ===`);
  if (todos.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const t of todos) {
    const box = t.done ? "[x]" : "[ ]";
    console.log(`  ${t.index}. ${box} ${t.text}`);
  }
}

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "add") {
  const text = args[1];
  if (!text) { console.error("Usage: todo add \"<text>\""); process.exit(1); }
  add(text);
} else if (cmd === "done") {
  const n = parseInt(args[1], 10);
  if (isNaN(n)) { console.error("Usage: todo done <n>"); process.exit(1); }
  setDone(n, true);
} else if (cmd === "undone") {
  const n = parseInt(args[1], 10);
  if (isNaN(n)) { console.error("Usage: todo undone <n>"); process.exit(1); }
  setDone(n, false);
} else if (cmd === "list") {
  const flag = args[1];
  if (!flag) {
    printTodos(list(), "All");
  } else if (flag === "--incomplete") {
    printTodos(list("incomplete"), "Incomplete");
  } else if (flag === "--completed") {
    printTodos(list("completed"), "Completed");
  } else {
    console.error(`Unknown flag: ${flag}`);
    process.exit(1);
  }
} else {
  console.log("Usage: todo <add|done|undone|list> [args]");
  process.exit(1);
}
