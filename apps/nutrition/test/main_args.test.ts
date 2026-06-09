/**
 * main_args.test.ts — the `serve` flag parsing in main.ts (node:util parseArgs).
 *
 * Drives the real entry point as a subprocess (keyless, offline). Asserts that a
 * bare or non-numeric `--port` is an explicit error (exit 1) rather than a silent
 * fall-back to the default, and that a valid `--port N` starts the HTTP server.
 * Each run uses a throwaway DB file under the OS tmp dir so it never touches the
 * repo's nutrition.db.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = join(APP_DIR, "src", "main.ts");
const tmp = mkdtempSync(join(tmpdir(), "nutrition-args-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

interface RunResult {
  code: number | null;
  stderr: string;
}

/** Spawn `main.ts <args>`. If `killOnListen` is set, resolve once it logs the HTTP line and kill it. */
function run(args: string[], killOnListen = false): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", MAIN, ...args], {
      env: { ...process.env, DB_PATH: join(tmp, `${Math.random().toString(36).slice(2)}.db`) },
      cwd: APP_DIR,
    });
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c;
      if (killOnListen && /HTTP http:\/\//.test(stderr)) {
        child.kill("SIGKILL");
      }
    });
    child.on("close", (code) => resolvePromise({ code, stderr }));
  });
}

test("serve --port with a non-numeric value exits 1 with a clear error", async () => {
  const { code, stderr } = await run(["serve", "--port", "abc"]);
  assert.equal(code, 1, "non-numeric --port exits 1");
  assert.match(stderr, /Invalid serve arguments/, "reports an arguments error");
  assert.match(stderr, /numeric value/, "explains --port must be numeric");
});

test("serve --port with no value exits 1 (no silent fall-back to default)", async () => {
  // parseArgs treats `--port` (string-typed) with nothing after it as a missing
  // option value and throws — main.ts maps that to exit 1.
  const { code, stderr } = await run(["serve", "--port"]);
  assert.equal(code, 1, "bare --port exits 1");
  assert.match(stderr, /Invalid serve arguments/);
});

test("serve --port <number> starts the HTTP server (valid numeric port accepted)", async () => {
  const { stderr } = await run(["serve", "--port", "0"], true);
  assert.match(stderr, /HTTP http:\/\//, "a valid numeric port boots the HTTP controller");
});
