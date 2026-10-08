#!/usr/bin/env node
// Command line entry. Needs Node 22.18 or newer, which runs the TypeScript sources directly.
// Silence only the "type stripping is experimental" notice; other warnings still print.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") process.stderr.write(`${w.name}: ${w.message}\n`);
});
// An installed package runs the bundled dist/cli.js (Node will not run .ts inside node_modules).
// A checkout of the repo has no dist/ unless you built it, and runs src/ directly.
import { existsSync } from "node:fs";
const built = new URL("../dist/cli.js", import.meta.url);
const { main } = await import(existsSync(built) ? built.href : "../src/cli.ts");
main(process.argv.slice(2));
