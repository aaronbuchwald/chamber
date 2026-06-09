/**
 * eval.test.ts — node:test entrypoint for the per-strategy nutrition eval harness.
 *
 * Loads the editable case list (test/eval/cases.ts) and runs each through the judging runner
 * (test/eval/runner.ts), reporting per-case pass / skip. Deterministic cases must pass with no
 * network; llm-judge cases SKIP cleanly when no ANTHROPIC_API_KEY / @anthropic-ai/sdk is present,
 * so the default suite stays offline and deterministic.
 *
 * To add or edit a case, change ONLY test/eval/cases.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cases } from "./eval/cases.js";
import { runCase } from "./eval/runner.js";

describe("nutrition eval harness (per-strategy cases)", () => {
  for (const c of cases) {
    it(`${c.id} [${c.strategy}/${c.mode}]`, async (t) => {
      const r = await runCase(c);
      if (r.status === "skip") {
        const msg = `SKIP ${c.id}: ${r.detail}`;
        // Prefer the test runner's native skip so it shows as skipped, not passed.
        if (typeof (t as any)?.skip === "function") (t as any).skip(msg);
        else console.log(msg);
        return;
      }
      assert.equal(r.status, "pass", `${c.id}: ${r.detail}`);
    });
  }
});
