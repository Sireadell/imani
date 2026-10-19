// npm run demo:app            simulated mode (default): no wallet, no network, pretend clock
// npm run demo:app -- --live  live mode: real payments, needs the IMANI_* settings in docs/demo/README.md
// Options: --port <n> (default 8787, or IMANI_PORT). If the default 8787 is taken, a free port is used
// instead. A port you ask for yourself (--port or IMANI_PORT) is never swapped: if it is taken, the demo says so and stops.
import { createServer as createNetServer } from "node:net";
import { createServer } from "node:http";
import { ConfigError, loadConfig } from "./config.ts";
import { createApp } from "./app.ts";

/** Can this port be opened on the loopback address right now? */
function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createNetServer();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

/** A free port picked by the system. */
function anyFreePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => done(p));
    });
  });
}

const argv = process.argv.slice(2);
const asked = argv.includes("--port") || process.env.IMANI_PORT !== undefined;
let cfg;
try {
  cfg = loadConfig({ argv, env: process.env });
  if (!asked && cfg.port !== 0 && !(await portFree(cfg.port))) {
    const free = await anyFreePort();
    console.log(`Port ${cfg.port} is in use, so the demo is using port ${free} instead.`);
    cfg = loadConfig({ argv: [...argv, "--port", String(free)], env: process.env });
  }
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(2);
  }
  throw e;
}

const app = createApp(cfg);
const server = createServer(app.handle);
server.once("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`Port ${cfg.port} is already in use. Pick another with --port <n> or IMANI_PORT, or leave both unset and the demo finds a free port itself.`);
    process.exit(2);
  }
  throw e;
});
server.listen(cfg.port, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : cfg.port;
  console.log(`Imani shop demo, ${cfg.mode === "sim" ? "SIMULATED mode (simulated payments, pretend clock, no network)" : "LIVE mode (real payments)"}`);
  console.log(`Open http://localhost:${port}`);
  console.log("Request log: method, path and status only. Keys, memos and addresses are never logged.");
});
