// The browser build of the library: what `import ... from "imani/browser"` gives a web page.
// The same checker the command line runs, with the payment reader (WebAssembly) embedded in the
// file, so the page downloads nothing else. It makes no network calls. Start the reader once with
// `await initReader()`, then call `runPage({ disclosure, result })`.
export { checkLot, type Verdict } from "./check.ts";
export { initReader, decoderInfo, runPage, parseJsonText, fileKind, lookupBid, type PageInputs, type PageOutcome } from "./site/engine.ts";
