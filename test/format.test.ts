import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { validateFiles } from "../src/check.ts";
import { runConformance } from "../tools/conformance.ts";

// The files other projects write (docs/FORMAT.md) are described by two JSON Schemas. This file holds a
// small validator for the keywords those schemas use, so the schemas are checked with no new dependency.
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const disclosureSchema = json("schema/disclosure.schema.json");
const resultSchema = json("schema/result.schema.json");

function validate(schema: any, value: any, root: any, path = "$"): string[] {
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((o: any, k: string) => o[k], root);
    return validate(target, value, root, path);
  }
  const errs: string[] = [];
  if (schema.anyOf) {
    const tried = schema.anyOf.map((s: any) => validate(s, value, root, path));
    return tried.some((e: string[]) => e.length === 0) ? [] : [`${path}: matches none of the allowed shapes (${tried.map((e: string[]) => e[0]).join(" | ")})`];
  }
  if ("const" in schema && value !== schema.const) errs.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: must be one of ${schema.enum.join(", ")}`);
  const kind = (v: any) => (Array.isArray(v) ? "array" : v === null ? "null" : Number.isInteger(v) ? "integer" : typeof v);
  if (schema.type) {
    if (kind(value) !== schema.type) return [...errs, `${path}: must be ${schema.type}`];
  }
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: does not match ${schema.pattern}`);
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: below ${schema.minimum}`);
  if (schema.type === "object") {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${path}: missing ${k}`);
    for (const [k, s] of Object.entries<any>(schema.properties ?? {})) if (k in value) errs.push(...validate(s, value[k], root, `${path}.${k}`));
  }
  if (schema.type === "array" && schema.items) value.forEach((v: any, i: number) => errs.push(...validate(schema.items, v, root, `${path}[${i}]`)));
  return errs;
}

// Every disclosure and result file under examples/ (honest rounds and broken copies).
const pairs: { id: string; d: string; r: string }[] = [];
for (const m of json("conformance/manifest.json").cases) pairs.push({ id: m.id, d: m.disclosure, r: m.result });

test("every example file validates against its schema", () => {
  assert.ok(pairs.length >= 66);
  for (const p of pairs) {
    // This copy is broken on purpose in a way the schema also refuses: a block height of 0. The checker's
    // close-height check is what a reader without a schema validator relies on, so the kit keeps it.
    if (p.id === "checks-broken/01-block-height-is-zero") {
      assert.deepEqual(validate(disclosureSchema, json(p.d), disclosureSchema), ["$.transactions[0].height: below 1"]);
      continue;
    }
    assert.deepEqual(validate(disclosureSchema, json(p.d), disclosureSchema), [], `${p.id} disclosure`);
    assert.deepEqual(validate(resultSchema, json(p.r), resultSchema), [], `${p.id} result`);
  }
});

test("the schemas catch real mistakes", () => {
  const d = json("examples/round-01/disclosure.json");
  const bad = (mut: (x: any) => void) => {
    const c = structuredClone(d);
    mut(c);
    return validate(disclosureSchema, c, disclosureSchema).length > 0;
  };
  assert.ok(bad((x) => (x.format = "imani-lot-disclosure/2")));
  assert.ok(bad((x) => delete x.transactions));
  assert.ok(bad((x) => (x.network = "dev")));
  assert.ok(bad((x) => (x.rules = { kind: "goal" })));
  assert.ok(bad((x) => (x.transactions[0].txHex = "xyz")));
  assert.ok(bad((x) => (x.ufvk = "uview1ABC")));
  const r = json("examples/round-01/result.json");
  const c = structuredClone(r);
  c.refunds[0].reason = "because";
  assert.ok(validate(resultSchema, c, resultSchema).length > 0);
});

test("the schemas and the checker's own validation agree on every example", () => {
  for (const p of pairs) {
    assert.doesNotThrow(() => validateFiles(json(p.d), json(p.r)), p.id);
  }
});

test("no field used in any example file is missing from the schemas (no drift)", () => {
  const top = new Set(Object.keys(disclosureSchema.properties));
  const rulesKeys = new Set(disclosureSchema.$defs.rules.anyOf.flatMap((s: any) => Object.keys(s.properties)));
  const rtop = new Set(Object.keys(resultSchema.properties));
  const totalsKeys = new Set(Object.keys(resultSchema.$defs.totals.properties));
  for (const p of pairs) {
    const d = json(p.d);
    const r = json(p.r);
    for (const k of Object.keys(d)) assert.ok(top.has(k), `${p.id}: disclosure key ${k} is not in the schema`);
    for (const k of Object.keys(d.rules)) assert.ok(rulesKeys.has(k), `${p.id}: rules key ${k} is not in the schema`);
    for (const k of Object.keys(r)) assert.ok(rtop.has(k), `${p.id}: result key ${k} is not in the schema`);
    for (const k of Object.keys(r.totals ?? {})) assert.ok(totalsKeys.has(k), `${p.id}: totals key ${k} is not in the schema`);
  }
});

test("the conformance manifest covers every broken copy under examples/", () => {
  const m = json("conformance/manifest.json");
  assert.equal(m.honest, 14);
  assert.equal(m.broken, 52);
  const dirs = readdirSync("examples").filter((d) => existsSync(`examples/${d}/manifest.json`));
  let copies = 0;
  for (const d of dirs) copies += json(`examples/${d}/manifest.json`).copies.length;
  assert.equal(copies, m.broken, "a broken copy under examples/ is not in conformance/manifest.json: run npm run conformance:make");
  for (const c of m.cases) for (const f of [c.disclosure, c.result, c.chain].filter(Boolean)) assert.ok(existsSync(f), f);
});

test("the conformance manifest is up to date", () => {
  const before = readFileSync("conformance/manifest.json", "utf8");
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "tools/make-conformance.ts"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync("conformance/manifest.json", "utf8"), before, "conformance/manifest.json was out of date and has been rewritten");
});

test("Imani's own checker scores full marks on the kit", () => {
  const s = runConformance("node bin/imani.js check");
  assert.equal(s.verdictRight, 66);
  assert.equal(s.named, 52);
  assert.equal(s.honestPassed, 14);
});

test("the kit can tell a weak checker from a good one", () => {
  // A checker that says PASS to everything gets every honest round right and every broken copy wrong.
  const dir = mkdtempSync(join(tmpdir(), "imani-conf-"));
  writeFileSync(join(dir, "always-pass.mjs"), "process.exit(0);");
  writeFileSync(join(dir, "always-fail.mjs"), "process.exit(1);");
  const weak = runConformance(`node "${join(dir, "always-pass.mjs")}"`);
  assert.equal(weak.honestPassed, 14);
  assert.equal(weak.verdictRight, 14);
  assert.equal(weak.named, 0);
  // A checker that says FAIL to everything gets the broken copies right but never names a check.
  const strict = runConformance(`node "${join(dir, "always-fail.mjs")}"`);
  assert.equal(strict.honestPassed, 0);
  assert.equal(strict.verdictRight, 52);
  assert.equal(strict.named, 0);
});
