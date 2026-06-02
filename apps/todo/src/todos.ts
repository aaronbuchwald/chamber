import * as fs from "fs";
import * as path from "path";

export interface Todo {
  index: number; // 1-based position in file
  done: boolean;
  text: string;
}

const DONE_RE = /^- \[x\] (.+)$/;
const OPEN_RE = /^- \[ \] (.+)$/;

function todoFilePath(): string {
  return path.join(process.cwd(), "todos.md");
}

function readLines(): string[] {
  const p = todoFilePath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n");
}

function writeLines(lines: string[]): void {
  fs.writeFileSync(todoFilePath(), lines.join("\n"), "utf8");
}

/** Parse all lines that are todo items; preserves non-todo lines. */
export function parseTodos(lines: string[]): Todo[] {
  const todos: Todo[] = [];
  let idx = 1;
  for (const line of lines) {
    const done = DONE_RE.exec(line);
    if (done) {
      todos.push({ index: idx++, done: true, text: done[1] });
      continue;
    }
    const open = OPEN_RE.exec(line);
    if (open) {
      todos.push({ index: idx++, done: false, text: open[1] });
    }
  }
  return todos;
}

function todoLine(todo: Omit<Todo, "index">): string {
  return todo.done ? `- [x] ${todo.text}` : `- [ ] ${todo.text}`;
}

// ── public operations ─────────────────────────────────────────────────────────

export function add(text: string): void {
  const lines = readLines();
  const newLine = `- [ ] ${text}`;
  // Ensure file ends without a trailing blank — just append
  if (lines.length === 0) {
    writeLines([newLine]);
  } else {
    // Remove trailing empty string from final newline split, then re-add
    const trimmed = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
    writeLines([...trimmed, newLine]);
  }
}

export function setDone(n: number, done: boolean): void {
  const lines = readLines();
  let todoCount = 0;
  const updated = lines.map((line) => {
    if (DONE_RE.test(line) || OPEN_RE.test(line)) {
      todoCount++;
      if (todoCount === n) {
        const text = (DONE_RE.exec(line) ?? OPEN_RE.exec(line))![1];
        return todoLine({ done, text });
      }
    }
    return line;
  });
  if (todoCount < n) {
    console.error(`No item at index ${n} (only ${todoCount} items).`);
    process.exit(1);
  }
  writeLines(updated);
}

export function list(filter?: "incomplete" | "completed"): Todo[] {
  const lines = readLines();
  const todos = parseTodos(lines);
  if (!filter) return todos;
  if (filter === "incomplete") return todos.filter((t) => !t.done);
  return todos.filter((t) => t.done);
}
