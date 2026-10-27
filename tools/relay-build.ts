// Bundles the block relay into api/block.mjs, the one server function of the hosted site.
// Run: npm run relay:build   (a test fails if the committed file is out of date)
// Plain JavaScript with every Imani module inlined, so the host runs it as it is, with no
// TypeScript step and nothing but Node's own modules.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function bundleRelay(outfile = join(root, "api", "block.mjs"), entry = "src/relay/vercel.ts", from = '"../../vendor/decoder/imani_decoder.js"'): Promise<string> {
  await build({
    entryPoints: [join(root, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    legalComments: "none",
    banner: { js: `// Built by npm run relay:build from ${entry}. Do not edit by hand.` },
    logLevel: "silent",
  });
  // The transaction id check loads the decoder from vendor/decoder by a path relative to its
  // source file. From api/ that folder is one level up; vercel.json ships it with the function.
  const text = readFileSync(outfile, "utf8");
  if (text.split(from).length !== 2) throw new Error("expected one decoder require in the relay bundle");
  const out = text.replace(from, '"../vendor/decoder/imani_decoder.js"');
  writeFileSync(outfile, out);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await bundleRelay();
  console.log(`Wrote api/block.mjs (${out.length.toLocaleString("en-US")} bytes).`);
  const chk = await bundleRelay(join(root, "api", "check.mjs"), "src/relay/check-vercel.ts");
  console.log(`Wrote api/check.mjs (${chk.length.toLocaleString("en-US")} bytes).`);
}
