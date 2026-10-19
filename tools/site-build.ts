// Builds the static page into site/ (or another folder). Run: npm run site:build
//
// The page runs the same checker as the command line tool, inside the visitor's browser:
//   src/check.ts, src/scan/*, src/rules.ts and src/report.ts are bundled as they are.
//   src/read.ts is swapped for src/site/read-browser.ts, which runs the same WebAssembly file
//   (vendor/decoder/imani_decoder_bg.wasm). Its bytes are embedded in app.js, so the page never
//   downloads anything after it loads. The wasm is not rebuilt: no Rust is needed.
//   node:crypto is swapped for a small pure JavaScript SHA-256 (src/site/crypto-shim.ts).
import { build, type Plugin } from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { roundRows, roundsPage } from "./rounds-list.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...s: string[]) => join(root, ...s);
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Refuse to build if the shipped decoder files are not the ones listed in SHA256SUMS. */
export function verifyVendor(): Record<string, string> {
  const sums: Record<string, string> = {};
  for (const line of readFileSync(p("vendor/decoder/SHA256SUMS"), "utf8").split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (m) sums[m[2]] = m[1];
  }
  for (const [file, want] of Object.entries(sums)) {
    const have = sha(readFileSync(p("vendor/decoder", file)));
    if (have !== want) throw new Error(`vendor/decoder/${file} does not match SHA256SUMS`);
  }
  return sums;
}

// The only Node-specific part of the generated decoder glue. Anything else means the decoder
// was rebuilt and this loader has to be looked at again.
const NODE_TAIL = [
  "const wasmPath = `${__dirname}/imani_decoder_bg.wasm`;",
  "const wasmBytes = require('fs').readFileSync(wasmPath);",
  "const wasmModule = new WebAssembly.Module(wasmBytes);",
  "let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());",
  "let wasm = wasmInstance.exports;",
  "wasm.__wbindgen_start();",
].join("\n");

/** The vendored glue, with its Node file loading replaced by loading from embedded bytes. */
export function browserGlue(): string {
  const src = readFileSync(p("vendor/decoder/imani_decoder.js"), "utf8").replace(/\r\n/g, "\n");
  const at = src.indexOf("const wasmPath");
  if (at < 0 || src.slice(at).trim() !== NODE_TAIL) {
    throw new Error("vendor/decoder/imani_decoder.js has a different loader than expected; update tools/site-build.ts");
  }
  const b64 = readFileSync(p("vendor/decoder/imani_decoder_bg.wasm")).toString("base64");
  return `const exports = {};
${src.slice(0, at)}
let wasm;
const WASM_B64 = "${b64}";
let cached;
export function wasmBytes() {
  if (!cached) {
    const bin = atob(WASM_B64);
    cached = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) cached[i] = bin.charCodeAt(i);
  }
  return cached;
}
export async function initGlue() {
  const r = await WebAssembly.instantiate(wasmBytes(), __wbg_get_imports());
  wasm = r.instance.exports;
  wasm.__wbindgen_start();
}
export { decryptTx, decoderInfo, parseAddress };
`;
}

const readText = (path: string) => readFileSync(path, "utf8");

/** The bundled example files, each distinct file stored once. */
export function exampleData(): { entries: any[]; externals: { id: string; title: string; blob: string }[]; blobs: Record<string, string> } {
  const blobs: Record<string, string> = {};
  const store = (path: string) => {
    const text = readText(path);
    const id = sha(text).slice(0, 16);
    blobs[id] = text;
    return id;
  };
  const nice = (name: string) => {
    const t = name.replace(/^\d+-/, "").replace(/-/g, " ");
    return t[0].toUpperCase() + t.slice(1);
  };
  const entries: any[] = [];
  const honest = (id: string, dir: string, title: string, story: string, scan: boolean, groupName?: "real-honest" | "receivers-honest" | "memo-honest" | "goal-honest") =>
    entries.push({
      id,
      group: groupName ?? (scan ? "scan-honest" : "honest"),
      title,
      story,
      expectedFailingCheck: null,
      disclosure: store(p("examples", dir, "disclosure.json")),
      result: store(p("examples", dir, "result.json")),
      chain: scan ? store(p("examples", dir, "chain.json")) : null,
    });
  const group = (base: string, baseDir: string, groupName: "real-tampered" | "tampered" | "scan-tampered" | "receivers-tampered" | "memo-tampered" | "goal-tampered") => {
    const manifest = JSON.parse(readText(p("examples", base, "manifest.json")));
    for (const c of manifest.copies) {
      const dir = join(base, c.name);
      const pick = (f: string) => (existsSync(p("examples", dir, f)) ? p("examples", dir, f) : p("examples", baseDir, f));
      entries.push({
        id: `${base}/${c.name}`,
        group: groupName,
        title: nice(c.name),
        story: c.story,
        expectedFailingCheck: c.expectedFailingCheck,
        ...(c.expectedFailingChecks ? { expectedFailingChecks: c.expectedFailingChecks } : {}),
        disclosure: store(pick("disclosure.json")),
        result: store(pick("result.json")),
        chain: groupName === "scan-tampered" || groupName === "real-tampered" ? store(pick("chain.json")) : null,
      });
    }
  };
  // The real round goes at the top: the page opens on it.
  honest(
    "testnet-01",
    "testnet-01",
    "Real round on the Zcash test network (DRY-01)",
    "A real wallet paid 3 bids into a fresh lot account on the public Zcash test network on 11 Oct 2026, and the lot paid 3 refunds back. 2 items, reserve 1,000,000 zatoshis. The scan reads all 34 real blocks of the auction (80 transactions) with the lot key and finds exactly the 6 payments of this lot.",
    true,
    "real-honest",
  );
  const ex = JSON.parse(readText(p("examples", "testnet-01", "explorer.json")));
  (entries[entries.length - 1] as Record<string, unknown>).explorer = ex.payments.map((x: { label: string; block: number; txid: string }) => ({
    label: `${x.label}, block ${x.block.toLocaleString("en-US")} (${x.txid.slice(0, 10)})`,
    url: `${ex.explorer}${x.txid}`,
  }));
  group("testnet-broken", "testnet-01", "real-tampered");
  honest(
    "round-01",
    "round-01",
    "Honest round (round 01)",
    "A small test auction: 2 items, reserve 1,000,000 zatoshis, four bids (one arrives after the close). The seller's files are exactly right.",
    false,
  );
  group("broken", "round-01", "tampered");
  honest(
    "scan-01",
    "scan-01",
    "Honest round with a full scan (scan 01)",
    "The same kind of auction, plus a saved copy of every block of the auction. The scan reads all 121 blocks with the lot key, so a bid the seller left out would show up.",
    true,
  );
  group("scan-broken", "scan-01", "scan-tampered");
  honest(
    "receivers-01",
    "receivers-01",
    "Honest round with refund addresses (receivers 01)",
    "The same auction, with the address each bid's refund must go to listed in the disclosure. Every refund went where it should.",
    false,
    "receivers-honest",
  );
  group("receivers-broken", "receivers-01", "receivers-tampered");
  honest(
    "memo-01",
    "memo-01",
    "Honest round with addresses in the bid memos (memo 01)",
    "The same auction, but each bidder wrote their own refund address at the end of their bid memo. The seller lists no addresses and could not choose them. Every refund went where its bidder said.",
    false,
    "memo-honest",
  );
  group("memo-broken", "memo-01", "memo-tampered");
  honest(
    "goal-reached",
    "goal-reached",
    "Fundraiser that reached its goal",
    "Not an auction: an all-or-nothing collection with a goal of 6,000,000 zatoshis. Three payments of 3,000,000, 2,000,000 and 1,500,000 came in on time, 6,500,000 in all, so the goal was reached and all three are kept. A fourth payment after the close is sent back.",
    false,
    "goal-honest",
  );
  honest(
    "goal-missed",
    "goal-missed",
    "Fundraiser that missed its goal",
    "The same kind of collection with a goal of 2,000,000 zatoshis. Only 1,500,000 came in on time, so the goal was missed and that payment is refunded in full, as is the late one.",
    false,
    "goal-honest",
  );
  group("goal-broken", "goal-reached", "goal-tampered");
  const externals = [
    ["external-settlement", "demo01-settlement", "Published settlement file"],
    ["external-reveal", "reveal", "Published reveal file"],
    ["external-tampered", "tampered", "Published reveal file, one refund changed"],
  ].map(([id, file, title]) => ({ id, title, blob: store(p("test", "external", "round-files", `${file}.json`)) }));
  return { entries, externals, blobs };
}

export function examplesModule(): string {
  const { entries, externals, blobs } = exampleData();
  return `export const examples = ${JSON.stringify(entries)};\nexport const externals = ${JSON.stringify(externals)};\nexport const blobs = ${JSON.stringify(blobs)};\n`;
}

/** The saved blocks of the real test-network round, for the "check any round" page's offline path. */
export function savedRoundModule(): string {
  return `export const savedRoundText = ${JSON.stringify(readText(p("examples", "testnet-01", "chain.json")))};
`;
}

function plugin(): Plugin {
  return {
    name: "imani-site",
    setup(b) {
      b.onResolve({ filter: /(^|[\\/])read\.ts$/ }, () => ({ path: p("src/site/read-browser.ts") }));
      b.onResolve({ filter: /(^|[\\/])reader\.ts$/ }, () => ({ path: p("src/site/read-browser.ts") }));
      b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: p("src/site/crypto-shim.ts") }));
      b.onResolve({ filter: /^imani-(decoder-glue|examples|saved-round)$/ }, (a) => ({ path: a.path, namespace: "imani-virtual" }));
      b.onLoad({ filter: /.*/, namespace: "imani-virtual" }, (a) => ({
        contents: a.path === "imani-decoder-glue" ? browserGlue() : a.path === "imani-saved-round" ? savedRoundModule() : examplesModule(),
        loader: "js",
        resolveDir: root,
      }));
    },
  };
}

const common = { bundle: true, plugins: [plugin()], target: "es2022", platform: "browser" as const, logLevel: "warning" as const, legalComments: "none" as const };

/** Bundle the page logic alone (no screen code) as a module, so tests can run the browser path in Node. */
export async function buildEngine(outfile: string): Promise<void> {
  verifyVendor();
  await build({ ...common, entryPoints: [p("src/site/engine.ts")], outfile, format: "esm" });
}

/** Build the whole static site into outDir. Returns the files written. */
export async function buildSite(outDir = p("site")): Promise<string[]> {
  const sums = verifyVendor();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  await build({ ...common, entryPoints: [p("src/site/app.ts")], outfile: join(outDir, "app.js"), format: "iife" });
  // The referee page: same checker, plus block requests to the site it is served from.
  await build({ ...common, entryPoints: [p("src/site/referee-app.ts")], outfile: join(outDir, "check.js"), format: "iife" });
  for (const f of readdirSync(p("src/site/static"))) copyFileSync(p("src/site/static", f), join(outDir, f));
  writeFileSync(join(outDir, "rounds.html"), roundsPage(roundRows()));
  const files = readdirSync(outDir).sort();
  const lines = files.map((f) => `${sha(readFileSync(join(outDir, f)))}  ${f}`);
  lines.push(`${sums["imani_decoder_bg.wasm"]}  imani_decoder_bg.wasm (embedded in app.js, same bytes as vendor/decoder)`);
  writeFileSync(join(outDir, "SHA256SUMS"), lines.join("\n") + "\n");
  return [...files, "SHA256SUMS"];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await buildSite();
  const kb = (f: string) => Math.round(readFileSync(p("site", f)).length / 1024);
  console.log(`Built site/: ${files.map((f) => `${f} (${kb(f)} KB)`).join(", ")}`);
}
