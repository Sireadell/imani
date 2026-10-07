// npm run demo:app            simulated mode (default): no wallet, no network, pretend clock
// npm run demo:app -- --live  live mode: real payments, needs the IMANI_* settings in docs/demo/README.md
// Options: --port <n> (default 8787, or IMANI_PORT).
import { createServer } from "node:http";
import { ConfigError, loadConfig } from "./config.ts";
import { createApp } from "./app.ts";

let cfg;
try {
  cfg = loadConfig({ argv: process.argv.slice(2), env: process.env });
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(2);
  }
  throw e;
}

const app = createApp(cfg);
const server = createServer(app.handle);
server.listen(cfg.port, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : cfg.port;
  console.log(`Imani shop demo, ${cfg.mode === "sim" ? "SIMULATED mode (simulated payments, pretend clock, no network)" : "LIVE mode (real payments)"}`);
  console.log(`Open http://localhost:${port}`);
  console.log("Request log: method, path and status only. Keys, memos and addresses are never logged.");
});
