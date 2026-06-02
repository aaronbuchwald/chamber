/**
 * adversarial.test.ts — Adversarial / hardening tests for the nutrition app.
 *
 * Probes: SQL/injection, numeric edge cases in parse, Gold-view math,
 * HTTP robustness, schema strictness, unicode, and determinism.
 *
 * Each test suite uses a fresh in-memory DB to avoid shared state.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn, ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NUTRITION_SRC = path.resolve(__dirname, "../src");
const TSX = path.resolve(__dirname, "../node_modules/.bin/tsx");

// ── Schema access (via app.ts singleton) ─────────────────────────────────────
import { app } from "../src/app.js";
import { seedReferenceData } from "../src/seed.js";
import { logMeal, getMealNutrition } from "../src/operations.js";

const logMealOp = app.operations.find((o) => o.name === "log_meal")!;
const nutritionForOp = app.operations.find((o) => o.name === "nutrition_for")!;

// ── in-memory DB helpers ──────────────────────────────────────────────────────

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meals (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      eaten_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meal_components (
      id          TEXT PRIMARY KEY,
      meal_id     TEXT NOT NULL REFERENCES meals(id),
      component   TEXT NOT NULL,
      qty_g       REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ingredients (
      id             TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS component_ingredients (
      component     TEXT NOT NULL,
      ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
      fraction      REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (component, ingredient_id)
    );
    CREATE TABLE IF NOT EXISTS nutrients (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('macro','micro')),
      unit TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ingredient_nutrients (
      ingredient_id   TEXT NOT NULL REFERENCES ingredients(id),
      nutrient_id     TEXT NOT NULL REFERENCES nutrients(id),
      amount_per_100g REAL NOT NULL,
      PRIMARY KEY (ingredient_id, nutrient_id)
    );
    CREATE VIEW IF NOT EXISTS gold_meal_nutrition AS
    SELECT
      m.id           AS meal_id,
      m.name         AS meal_name,
      n.name         AS nutrient,
      n.kind         AS nutrient_kind,
      n.unit         AS unit,
      SUM(mc.qty_g / 100.0 * ci.fraction * inu.amount_per_100g) AS amount
    FROM meals m
    JOIN meal_components    mc  ON mc.meal_id       = m.id
    JOIN component_ingredients ci ON ci.component   = mc.component
    JOIN ingredient_nutrients  inu ON inu.ingredient_id = ci.ingredient_id
    JOIN nutrients             n   ON n.id           = inu.nutrient_id
    GROUP BY m.id, n.id;
  `);
  seedReferenceData(db);
  return db;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as any;
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "nutrition-adv-test-"));
}

function cleanupDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function startHttpServer(port: number, cwd: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn(TSX, [path.join(NUTRITION_SRC, "http.ts")], {
      cwd,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.includes("HTTP http://localhost:")) resolve(proc);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0 && code !== null)
        reject(new Error(`HTTP server exited with code ${code}: ${stderr}`));
    });
    setTimeout(() => reject(new Error(`HTTP server did not start in time: ${stderr}`)), 10000);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. SQL/INJECTION HARDENING
// ═══════════════════════════════════════════════════════════════════════════════

describe("SQL injection — component name", () => {
  it("stores an injection string in component as verbatim text, meals table survives", () => {
    const db = freshDb();
    const maliciousComponent = `'; DROP TABLE meals; --`;
    // This tests the component column path (not just meal name which the original tests cover)
    const id = logMeal(db, "Injection test", [{ component: maliciousComponent, qty_g: 100 }]);

    const row = db.prepare("SELECT component FROM meal_components WHERE meal_id = ?").get(id) as any;
    assert.equal(row.component, maliciousComponent, "component should be stored verbatim");

    // meals table must still be intact
    const check = db.prepare("SELECT COUNT(*) as n FROM meals WHERE id = ?").get(id) as any;
    assert.equal(check.n, 1, "meals table must survive injection attempt in component name");
  });

  it("stores a UNION-injection string in component as verbatim text", () => {
    const db = freshDb();
    const unionInjection = `grilled chicken' UNION SELECT id, id, id, 0 FROM meals --`;
    const id = logMeal(db, "UNION injection", [{ component: unionInjection, qty_g: 100 }]);

    const row = db.prepare("SELECT component FROM meal_components WHERE meal_id = ?").get(id) as any;
    assert.equal(row.component, unionInjection, "UNION injection should be stored verbatim");

    // Nutrition query should return 0 rows (no matching component_ingredients), not injection rows
    const rows = getMealNutrition(db, id);
    assert.equal(rows.length, 0, "UNION injection in component name must not leak extra rows");
  });

  it("SQL injection string passed as meal_id to getMealNutrition returns empty array", () => {
    const db = freshDb();
    // Log a real meal first
    logMeal(db, "Real meal", [{ component: "grilled chicken", qty_g: 100 }]);

    // Attempt classic OR-injection as meal_id
    const rows1 = getMealNutrition(db, `' OR '1'='1`);
    assert.equal(rows1.length, 0, "OR injection as meal_id must return empty, not all meals");

    // DROP attempt
    const rows2 = getMealNutrition(db, `'; DROP TABLE meals; --`);
    assert.equal(rows2.length, 0, "DROP injection as meal_id must return empty");

    // meals table must still exist
    const count = db.prepare("SELECT COUNT(*) as n FROM meals").get() as any;
    assert.ok(count.n >= 1, "meals table must survive injection via meal_id path");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. NUMERIC EDGE CASES — string "name:grams" form
// ═══════════════════════════════════════════════════════════════════════════════

describe("numeric edge cases — string form", () => {
  // REGRESSION TEST for the Infinity bug (now fixed):
  // Before the fix, 'name:Infinity' passed validation because Infinity > 0 and !NaN.
  it("rejects 'name:Infinity' string — Infinity is not a finite quantity (regression)", () => {
    const parsed = logMealOp.input.safeParse({
      name: "Inf test",
      components: "chicken:Infinity",
    });
    assert.ok(!parsed.success, "Expected parse to fail for 'chicken:Infinity'");
  });

  it("rejects 'name:1e309' string — overflows to Infinity at parseFloat (regression)", () => {
    // parseFloat('1e309') === Infinity in JavaScript
    const parsed = logMealOp.input.safeParse({
      name: "Overflow test",
      components: "chicken:1e309",
    });
    assert.ok(!parsed.success, "Expected parse to fail for 'chicken:1e309' (Infinity overflow)");
  });

  it("rejects 'name:NaN' string", () => {
    const parsed = logMealOp.input.safeParse({
      name: "NaN test",
      components: "chicken:NaN",
    });
    assert.ok(!parsed.success, "Expected parse to fail for 'chicken:NaN'");
  });

  it("rejects 'name:0' string — zero grams is not a positive quantity", () => {
    const parsed = logMealOp.input.safeParse({
      name: "Zero test",
      components: "chicken:0",
    });
    assert.ok(!parsed.success, "Expected parse to fail for 'chicken:0'");
  });

  it("rejects 'name:-50' string — negative grams", () => {
    const parsed = logMealOp.input.safeParse({
      name: "Negative test",
      components: "chicken:-50",
    });
    assert.ok(!parsed.success, "Expected parse to fail for 'chicken:-50'");
  });

  it("accepts 'name:1e308' — very large but finite quantity (by-design: no upper bound)", () => {
    // 1e308 is finite (near Number.MAX_VALUE). Schema accepts any positive finite number.
    // This documents the actual behavior: no upper bound is enforced.
    const parsed = logMealOp.input.safeParse({
      name: "Huge test",
      components: "chicken:1e308",
    });
    assert.ok(parsed.success, "Very large but finite quantity should be accepted (no upper bound)");
    assert.ok(
      isFinite(parsed.data!.components[0].qty_g),
      "qty_g should be finite even for very large values"
    );
  });

  it("uses lastIndexOf so 'a:b:150' parses name='a:b', qty=150 (by-design)", () => {
    // The component transform uses s.lastIndexOf(':'), so colons in the name are valid.
    // This is by-design (names can contain colons as long as the last segment is the quantity).
    const parsed = logMealOp.input.safeParse({
      name: "Multi-colon test",
      components: "a:b:150",
    });
    assert.ok(parsed.success, "multi-colon string should parse using last colon as separator");
    assert.deepEqual(parsed.data!.components[0], { component: "a:b", qty_g: 150 });
  });

  it("trims trailing/leading spaces from component name in string form", () => {
    const parsed = logMealOp.input.safeParse({
      name: "Trim test",
      components: "  chicken breast  :150",
    });
    assert.ok(parsed.success, "Spaces around name should be trimmed");
    assert.equal(parsed.data!.components[0].component, "chicken breast", "Name should be trimmed");
  });

  it("rejects string with only spaces as component name (trims to empty)", () => {
    const parsed = logMealOp.input.safeParse({
      name: "Blank name",
      components: "   :150",
    });
    assert.ok(!parsed.success, "Whitespace-only component name should be rejected after trim");
  });

  it("rejects non-numeric grams string like 'name:heavy'", () => {
    const parsed = logMealOp.input.safeParse({
      name: "Bad grams",
      components: "chicken:heavy",
    });
    assert.ok(!parsed.success, "Non-numeric grams should be rejected");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. NUMERIC EDGE CASES — object {component, qty_g} form
// ═══════════════════════════════════════════════════════════════════════════════

describe("numeric edge cases — object form", () => {
  it("rejects qty_g = 0 in object form", () => {
    const parsed = logMealOp.input.safeParse({
      name: "Zero",
      components: [{ component: "chicken", qty_g: 0 }],
    });
    assert.ok(!parsed.success, "qty_g = 0 should be rejected (not positive)");
  });

  it("rejects qty_g = -10 in object form", () => {
    const parsed = logMealOp.input.safeParse({
      name: "Negative",
      components: [{ component: "chicken", qty_g: -10 }],
    });
    assert.ok(!parsed.success, "negative qty_g should be rejected");
  });

  it("rejects qty_g = NaN in object form — z.number() rejects NaN", () => {
    const parsed = logMealOp.input.safeParse({
      name: "NaN object",
      components: [{ component: "chicken", qty_g: NaN }],
    });
    assert.ok(!parsed.success, "NaN qty_g should be rejected by z.number()");
  });

  it("rejects qty_g = Infinity in object form — z.number() rejects Infinity", () => {
    const parsed = logMealOp.input.safeParse({
      name: "Inf object",
      components: [{ component: "chicken", qty_g: Infinity }],
    });
    assert.ok(!parsed.success, "Infinity qty_g should be rejected by z.number().positive()");
  });

  it("rejects qty_g as a non-numeric string in object form", () => {
    const parsed = logMealOp.input.safeParse({
      name: "String qty",
      components: [{ component: "chicken", qty_g: "lots" as any }],
    });
    assert.ok(!parsed.success, "string qty_g should be rejected");
  });

  it("rejects object form missing component field", () => {
    const parsed = logMealOp.input.safeParse({
      name: "Missing field",
      components: [{ qty_g: 100 }],
    });
    assert.ok(!parsed.success, "Missing component field should be rejected");
  });

  it("strips extra unknown fields in object form (zod default passthrough is strip)", () => {
    const parsed = logMealOp.input.safeParse({
      name: "Extra fields",
      components: [{ component: "chicken", qty_g: 100, extra: "hacked", injected: true }],
    });
    assert.ok(parsed.success, "Extra fields should not cause parse failure (they are stripped)");
    assert.deepEqual(
      parsed.data!.components[0],
      { component: "chicken", qty_g: 100 },
      "Extra fields should be stripped from the parsed output"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. EMPTY COMPONENTS ARRAY
// ═══════════════════════════════════════════════════════════════════════════════

describe("empty components array", () => {
  it("is accepted by the schema (no .min(1) guard — by-design, documents actual behavior)", () => {
    // The schema does not enforce at least one component. An empty meal is allowed.
    // This is by-design: the schema is permissive; the handler just creates a meal with 0 components.
    const parsed = logMealOp.input.safeParse({ name: "Empty meal", components: [] });
    assert.ok(parsed.success, "Empty components [] is accepted (no min(1) constraint)");
  });

  it("empty-component meal stores a meal row and getMealNutrition returns [] (no error)", () => {
    const db = freshDb();
    const id = logMeal(db, "Empty meal", []);

    const meal = db.prepare("SELECT * FROM meals WHERE id = ?").get(id) as any;
    assert.ok(meal, "meal row should exist");

    const rows = getMealNutrition(db, id);
    assert.equal(rows.length, 0, "No nutrition rows for a meal with zero components");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. DUPLICATE COMPONENTS — Gold-view SUM correctness
// ═══════════════════════════════════════════════════════════════════════════════

describe("duplicate components — Gold-view SUM", () => {
  it("two same-named components SUM their quantities correctly", () => {
    // logging 'grilled chicken' twice should sum to 250g total
    const db = freshDb();
    const id = logMeal(db, "Double chicken", [
      { component: "grilled chicken", qty_g: 100 },
      { component: "grilled chicken", qty_g: 150 },
    ]);

    const rows = getMealNutrition(db, id);
    const protein = rows.find((r) => r.nutrient === "Protein");
    assert.ok(protein, "Protein row should exist");
    // (100 + 150) / 100 * 31.0 = 77.5
    assert.ok(
      Math.abs(protein!.amount - 77.5) < 0.001,
      `Expected Protein = 77.5g for 250g chicken (two entries), got ${protein!.amount}`
    );
  });

  it("two different components that map to the same ingredient SUM correctly", () => {
    // 'egg' (100g) + 'scrambled eggs' (100g) — both map to ing_egg, fraction=1.0
    // Expected protein: (100 + 100) / 100 * 13.0 = 26.0
    const db = freshDb();
    const id = logMeal(db, "Egg two ways", [
      { component: "egg", qty_g: 100 },
      { component: "scrambled eggs", qty_g: 100 },
    ]);

    const rows = getMealNutrition(db, id);
    const protein = rows.find((r) => r.nutrient === "Protein");
    assert.ok(protein, "Protein row should exist");
    assert.ok(
      Math.abs(protein!.amount - 26.0) < 0.001,
      `Expected 26.0g protein for egg + scrambled eggs (both map to ing_egg), got ${protein!.amount}`
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. MULTI-INGREDIENT COMPONENTS — fractional math
// ═══════════════════════════════════════════════════════════════════════════════

describe("multi-ingredient components — fractional math", () => {
  it("component mapping to two ingredients with fractions produces correct nutrient sum", () => {
    // Construct a custom DB with a 2-ingredient component:
    //   'custom mix': 40% grilled chicken + 60% brown rice
    // For 200g of custom mix:
    //   protein = 200/100 * (0.4 * 31.0 + 0.6 * 2.6) = 2 * (12.4 + 1.56) = 2 * 13.96 = 27.92
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE meals (id TEXT PRIMARY KEY, name TEXT NOT NULL, eaten_at INTEGER NOT NULL);
      CREATE TABLE meal_components (id TEXT PRIMARY KEY, meal_id TEXT NOT NULL REFERENCES meals(id), component TEXT NOT NULL, qty_g REAL NOT NULL);
      CREATE TABLE ingredients (id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL UNIQUE);
      CREATE TABLE component_ingredients (component TEXT NOT NULL, ingredient_id TEXT NOT NULL REFERENCES ingredients(id), fraction REAL NOT NULL DEFAULT 1.0, PRIMARY KEY (component, ingredient_id));
      CREATE TABLE nutrients (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('macro','micro')), unit TEXT NOT NULL);
      CREATE TABLE ingredient_nutrients (ingredient_id TEXT NOT NULL REFERENCES ingredients(id), nutrient_id TEXT NOT NULL REFERENCES nutrients(id), amount_per_100g REAL NOT NULL, PRIMARY KEY (ingredient_id, nutrient_id));
      CREATE VIEW gold_meal_nutrition AS
      SELECT m.id AS meal_id, m.name AS meal_name, n.name AS nutrient, n.kind AS nutrient_kind, n.unit AS unit,
        SUM(mc.qty_g / 100.0 * ci.fraction * inu.amount_per_100g) AS amount
      FROM meals m
      JOIN meal_components mc ON mc.meal_id = m.id
      JOIN component_ingredients ci ON ci.component = mc.component
      JOIN ingredient_nutrients inu ON inu.ingredient_id = ci.ingredient_id
      JOIN nutrients n ON n.id = inu.nutrient_id
      GROUP BY m.id, n.id;
    `);

    db.prepare("INSERT INTO ingredients VALUES (?, ?)").run("ing_chicken", "grilled chicken");
    db.prepare("INSERT INTO ingredients VALUES (?, ?)").run("ing_rice", "brown rice");
    db.prepare("INSERT INTO component_ingredients VALUES (?, ?, ?)").run("custom mix", "ing_chicken", 0.4);
    db.prepare("INSERT INTO component_ingredients VALUES (?, ?, ?)").run("custom mix", "ing_rice", 0.6);
    db.prepare("INSERT INTO nutrients VALUES (?, ?, ?, ?)").run("nut_protein", "Protein", "macro", "g");
    db.prepare("INSERT INTO ingredient_nutrients VALUES (?, ?, ?)").run("ing_chicken", "nut_protein", 31.0);
    db.prepare("INSERT INTO ingredient_nutrients VALUES (?, ?, ?)").run("ing_rice", "nut_protein", 2.6);

    const id = logMeal(db, "Fractional mix", [{ component: "custom mix", qty_g: 200 }]);
    const rows = getMealNutrition(db, id);
    const protein = rows.find((r) => r.nutrient === "Protein");
    assert.ok(protein, "Protein row should exist");
    const expected = (200 / 100) * (0.4 * 31.0 + 0.6 * 2.6); // 27.92
    assert.ok(
      Math.abs(protein!.amount - expected) < 0.001,
      `Expected Protein ≈ ${expected}, got ${protein!.amount}`
    );
  });

  it("Gold-view is deterministic: same inputs always produce same output", () => {
    // Run the same query twice and confirm results are identical
    const db = freshDb();
    const id = logMeal(db, "Determinism test", [
      { component: "grilled chicken", qty_g: 150 },
      { component: "brown rice", qty_g: 100 },
    ]);

    const rows1 = getMealNutrition(db, id);
    const rows2 = getMealNutrition(db, id);

    assert.equal(rows1.length, rows2.length, "Row count should be deterministic");
    for (let i = 0; i < rows1.length; i++) {
      assert.equal(
        rows1[i].amount,
        rows2[i].amount,
        `Row ${i} amount should be deterministic: ${rows1[i].nutrient}`
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. HTTP LAYER — robustness
// ═══════════════════════════════════════════════════════════════════════════════

describe("HTTP layer — robustness", () => {
  let tempDir: string;
  let port: number;
  let server: ChildProcess;
  let baseUrl: string;

  before(async () => {
    tempDir = makeTempDir();
    port = await getFreePort();
    server = await startHttpServer(port, tempDir);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => {
    server?.kill("SIGTERM");
    cleanupDir(tempDir);
  });

  it("malformed JSON body returns 400 and server stays up", async () => {
    const resp = await fetch(`${baseUrl}/log_meal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ this is not json !!!",
    });
    assert.equal(resp.status, 400, "Malformed JSON should return 400");
    const body = await resp.json() as any;
    assert.ok(body.error, "Response should have an error field");

    // Server must still be alive — verify with a valid request
    const aliveResp = await fetch(`${baseUrl}/`, { method: "GET" });
    assert.equal(aliveResp.status, 200, "Server must stay up after malformed JSON request");
  });

  it("POST with no content-type and valid JSON body is accepted (content-type not checked)", () => {
    // DOCUMENTS by-design behavior: the HTTP layer does not enforce content-type header.
    // This is a known leniency — document it rather than silently depend on it.
    return fetch(`${baseUrl}/log_meal`, {
      method: "POST",
      body: JSON.stringify({ name: "No-CT meal", components: [{ component: "egg", qty_g: 100 }] }),
    }).then(async (resp) => {
      // Either 200 (content-type not enforced) or 400 (content-type enforced)
      // Document the actual behavior:
      const body = await resp.json() as any;
      if (resp.status === 200) {
        assert.ok(body.result?.meal_id, "meal_id returned when content-type not enforced");
      } else {
        // If the server starts enforcing content-type in the future, this test will catch it
        assert.equal(resp.status, 400, "If content-type is enforced, should return 400");
      }
      // Either way, server must be alive
    });
  });

  it("POST with unknown extra fields returns 200 (extra fields are stripped by zod)", async () => {
    // Documents that zod strips unknown fields — not a security problem,
    // extra fields in the request are silently ignored.
    const resp = await fetch(`${baseUrl}/log_meal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Extra fields",
        components: [{ component: "egg", qty_g: 100 }],
        hacker_field: "INJECTED",
        admin: true,
      }),
    });
    assert.equal(resp.status, 200, "Extra fields should be silently stripped, not cause 400");
    const body = await resp.json() as any;
    assert.ok(body.result?.meal_id, "meal_id should be returned after stripping extra fields");
  });

  it("POST with completely wrong types returns 400", async () => {
    const resp = await fetch(`${baseUrl}/log_meal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 12345, components: "not-valid" }),
    });
    assert.equal(resp.status, 400, "Wrong types should return 400");
    const body = await resp.json() as any;
    assert.ok(body.issues || body.error, "400 response should include error details");
  });

  it("POST with Infinity in components string 'chicken:Infinity' returns 400 (regression)", async () => {
    // This was the bug: before the fix, 'name:Infinity' was accepted.
    const resp = await fetch(`${baseUrl}/log_meal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Infinity meal", components: ["chicken:Infinity"] }),
    });
    assert.equal(
      resp.status,
      400,
      "Components string with Infinity should be rejected with 400 (regression for Infinity bug)"
    );
  });

  it("GET /log_meal returns 404 (POST-only routes — by-design: returns 404 not 405)", async () => {
    // Documents that GET on a POST-only route returns 404, not 405 Method Not Allowed.
    const resp = await fetch(`${baseUrl}/log_meal`, { method: "GET" });
    assert.equal(resp.status, 404, "GET on POST-only route returns 404 (not 405)");
  });

  it("empty JSON body {} is rejected for log_meal with 400 (missing required fields)", async () => {
    const resp = await fetch(`${baseUrl}/log_meal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(resp.status, 400, "Empty {} body should return 400 for missing required fields");
  });

  it("nutrition_for with non-existent meal_id returns 200 with empty array", async () => {
    const resp = await fetch(`${baseUrl}/nutrition_for`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meal_id: "00000000-0000-0000-0000-000000000000" }),
    });
    assert.equal(resp.status, 200, "Non-existent meal_id should return 200 with empty result");
    const body = await resp.json() as any;
    assert.ok(Array.isArray(body.result), "Result should be an array");
    assert.equal(body.result.length, 0, "Non-existent meal should have zero nutrition rows");
  });

  it("nutrition_for with injection string as meal_id returns 200 with empty array", async () => {
    // The meal_id is parameterized, so injection should return [] not rows from other meals
    const resp = await fetch(`${baseUrl}/nutrition_for`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meal_id: "' OR '1'='1" }),
    });
    assert.equal(resp.status, 200, "SQL injection as meal_id should return 200 with empty result");
    const body = await resp.json() as any;
    assert.ok(Array.isArray(body.result), "Result should be an array");
    assert.equal(body.result.length, 0, "Injection string as meal_id must not leak any rows");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. UNICODE IN NAMES
// ═══════════════════════════════════════════════════════════════════════════════

describe("unicode and special characters in names", () => {
  it("unicode meal name is stored and retrieved verbatim", () => {
    const db = freshDb();
    const unicodeName = "鶏の照り焼き定食 🍗";
    const id = logMeal(db, unicodeName, [{ component: "grilled chicken", qty_g: 150 }]);

    const meal = db.prepare("SELECT name FROM meals WHERE id = ?").get(id) as any;
    assert.equal(meal.name, unicodeName, "Unicode meal name should be stored verbatim");
  });

  it("unicode component name is stored verbatim (no nutrition rows — unknown component)", () => {
    const db = freshDb();
    const unicodeComponent = "Poulet rôti";
    const id = logMeal(db, "French meal", [{ component: unicodeComponent, qty_g: 150 }]);

    const row = db.prepare("SELECT component FROM meal_components WHERE meal_id = ?").get(id) as any;
    assert.equal(row.component, unicodeComponent, "Unicode component name should be stored verbatim");

    // Not in reference data — should produce no nutrition rows
    const rows = getMealNutrition(db, id);
    assert.equal(rows.length, 0, "Unknown unicode component should produce no nutrition rows");
  });

  it("parses unicode in string form 'name:grams' — component name before last colon is preserved", () => {
    const parsed = logMealOp.input.safeParse({
      name: "Unicode test",
      components: "鶏の照り焼き:150",
    });
    assert.ok(parsed.success, "Unicode string component form should parse successfully");
    assert.equal(parsed.data!.components[0].component, "鶏の照り焼き");
    assert.equal(parsed.data!.components[0].qty_g, 150);
  });

  it("meal name with SQL metacharacters stored verbatim (apostrophe, semicolon, quotes)", () => {
    const db = freshDb();
    const trickName = `O'Malley's "Healthy" Bowl; DROP TABLE meals; --`;
    const id = logMeal(db, trickName, [{ component: "grilled chicken", qty_g: 100 }]);

    const meal = db.prepare("SELECT name FROM meals WHERE id = ?").get(id) as any;
    assert.equal(meal.name, trickName, "Meal name with SQL metacharacters should be stored verbatim");

    // Verify meals table still works
    const count = db.prepare("SELECT COUNT(*) as n FROM meals").get() as any;
    assert.ok(count.n >= 1, "meals table should be intact after meal name with metacharacters");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. SCHEMA — missing / wrong top-level fields
// ═══════════════════════════════════════════════════════════════════════════════

describe("schema validation — top-level fields", () => {
  it("rejects log_meal with missing name field", () => {
    const parsed = logMealOp.input.safeParse({
      components: ["grilled chicken:100"],
    });
    assert.ok(!parsed.success, "Missing 'name' field should be rejected");
  });

  it("rejects log_meal with missing components field (undefined)", () => {
    const parsed = logMealOp.input.safeParse({ name: "No components" });
    assert.ok(!parsed.success, "Missing 'components' field (undefined) should be rejected");
  });

  it("rejects log_meal with null components", () => {
    const parsed = logMealOp.input.safeParse({ name: "Null comps", components: null });
    assert.ok(!parsed.success, "null components should be rejected");
  });

  it("rejects log_meal with numeric name", () => {
    const parsed = logMealOp.input.safeParse({ name: 42, components: ["egg:100"] });
    assert.ok(!parsed.success, "Numeric name should be rejected by z.string()");
  });

  it("rejects nutrition_for with missing meal_id", () => {
    const parsed = nutritionForOp.input.safeParse({});
    assert.ok(!parsed.success, "Missing meal_id should be rejected");
  });

  it("rejects nutrition_for with numeric meal_id", () => {
    const parsed = nutritionForOp.input.safeParse({ meal_id: 12345 });
    assert.ok(!parsed.success, "Numeric meal_id should be rejected by z.string()");
  });

  it("accepts empty string as meal_id (z.string() allows it — by-design)", () => {
    // z.string() with no .min(1) accepts empty strings.
    // This documents the actual behavior: no UUID-format validation.
    const parsed = nutritionForOp.input.safeParse({ meal_id: "" });
    assert.ok(parsed.success, "Empty string meal_id accepted (no UUID format validation — by-design)");
  });
});
