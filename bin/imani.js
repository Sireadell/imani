#!/usr/bin/env node
// Command line entry. Needs Node 22.18 or newer, which runs the TypeScript sources directly.
// Silence only the "type stripping is experimental" notice; other warnings still print.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") process.stderr.write(`${w.name}: ${w.message}\n`);
});
const { main } = await import("../src/cli.ts");
main(process.argv.slice(2));
