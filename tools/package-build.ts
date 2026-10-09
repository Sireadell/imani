// Builds dist/ for the npm package. Run: npm run build (npm pack and npm publish run it first).
//
// Why: Node refuses to run .ts files that sit inside node_modules, so an installed copy of this
// package cannot run src/ directly. dist/cli.js and dist/login.js are the same code as src/,
// bundled into plain JavaScript. The WebAssembly decoder stays in vendor/decoder (checked
// against SHA256SUMS first) and is loaded from there at run time.
import { build, type Plugin } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyVendor } from "./site-build.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const p = (...s: string[]) => join(root, ...s);

// src/fetch/verify.ts sits one folder deeper than src/read.ts, so it reaches the decoder with
// "../../vendor". Bundled into dist/, that path is one level too high.
const vendorPath: Plugin = {
  name: "vendor-path",
  setup(b) {
    b.onLoad({ filter: /fetch[\\/]verify\.ts$/ }, (args) => {
      const text = readFileSync(args.path, "utf8");
      if (!text.includes('"../../vendor/decoder/imani_decoder.js"')) throw new Error("verify.ts no longer loads the decoder the way the package build expects");
      return { contents: text.replace('"../../vendor/decoder/imani_decoder.js"', '"../vendor/decoder/imani_decoder.js"'), loader: "ts" };
    });
  },
};

export async function buildPackage(outDir = p("dist")): Promise<void> {
  verifyVendor();
  rmSync(outDir, { recursive: true, force: true });
  await build({
    entryPoints: { cli: p("src/cli.ts"), login: p("src/login/index.ts") },
    outdir: outDir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    legalComments: "none",
    plugins: [vendorPath],
    logLevel: "warning",
  });
  // Type definitions for imani/login, so TypeScript users get types from the installed package.
  const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", p("tsconfig.types.json"), "--outDir", join(outDir, "types")], { cwd: root, stdio: "inherit" });
  // The sources import each other with .ts endings. In the shipped definitions, point them at .js.
  const fix = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) fix(f);
      else if (f.endsWith(".d.ts")) writeFileSync(f, readFileSync(f, "utf8").replace(/(\bfrom\s+")(\.{1,2}\/[^"]+)\.ts(")/g, "$1$2.js$3"));
    }
  };
  fix(join(outDir, "types"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPackage();
  console.log("Built dist/cli.js, dist/login.js and dist/types/");
}
